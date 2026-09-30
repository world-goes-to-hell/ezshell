# 세션 등록/수정 모달: 연결 테스트

## 목표
새 연결, 연결 편집, 세션 복제 모달에서 저장하거나 접속하기 전에, 입력한 정보로 로그인이 되는지 미리 확인한다.

## 동작
- 모달 하단 왼쪽의 `연결 테스트` 버튼을 누르면 현재 입력값으로 SSH 인증까지만 시도하고 곧바로 연결을 끊는다. 셸을 열지 않으므로 서버에서 아무 명령도 실행되지 않는다.
- 결과는 버튼 위에 표시한다.
  - 성공: `연결에 성공했습니다. (320ms, Jump Host 경유)`
  - 실패: 원인 문구, 확인할 항목 안내, 원본 오류 메시지(선택 가능)
  - Jump Host 단계에서 실패하면 `[Jump Host]` 를 앞에 붙인다.
- 호스트/사용자명(및 Jump 설정을 켠 경우 Jump 호스트/사용자명)이 비어 있으면 브라우저 기본 필수 입력 안내를 띄우고 테스트하지 않는다.
- 입력을 수정하거나 모달을 다시 열면 이전 결과는 지워지고, 진행 중이던 테스트 결과도 무시된다.
- 연결 타임아웃은 고급 설정의 값을 그대로 쓴다.

## 설계
| 파일 | 역할 |
|------|------|
| `src/sshConnectionTest.js` | 메인 프로세스용 테스트 로직, 오류 메시지 매핑 |
| `src/sshConnectionTest.test.js` | 단위 테스트 15건 (ssh2 Client 가짜 객체 주입) |
| `main.js` | `ssh-test-connection` IPC 핸들러 |
| `src/preload.js`, `src/renderer/types/index.ts` | `sshTestConnection` 노출과 결과 타입 |
| `src/renderer/components/Modal/ConnectionTest.tsx`/`.css` | `useConnectionTest` 훅과 결과 표시 컴포넌트 |
| `src/renderer/components/Modal/ConnectModal.tsx` | 버튼/결과 연결 |
| `electron.vite.config.ts` | 런타임 복사 목록에 `sshConnectionTest.js` 추가 (빌드 산출물 누락 방지) |

- 오류 분류: 인증 실패, Passphrase 오류, 키 형식 오류, 연결 거부, 호스트 없음, 도달 불가, 연결 끊김, 시간 초과.
- ssh2 의 `readyTimeout` 에 더해 자체 안전 타이머(readyTimeout × 단계 수 + 5초)를 두어 응답이 없어도 결과가 반드시 돌아오게 했다.
- 새 preload API 가 없는 상태(앱 재시작 전)에서는 "앱을 다시 시작한 뒤 사용" 안내를 표시한다.

## 진행 상황
- [x] 메인 로직 + 단위 테스트 15건
- [x] IPC / preload / 타입
- [x] 모달 UI
- [x] `npm run typecheck` 오류 0건, `vitest run` 100 passed
- [x] 로컬 임시 ssh2 서버로 통합 확인: 성공, 비밀번호 오류, Jump 경유 성공, Jump 인증 실패, 연결 거부, 호스트 없음, 키 파일 없음 → 모두 기대 결과, 서버 측 세션 미개설, 남은 연결 0
- [x] 실행 중인 앱(HMR)에서 버튼 렌더링, 필수 입력 검증, 결과 표시, 수정 시 초기화 확인
- [ ] 앱 재시작 후 모달에서 실제 서버로 성공/실패 표시 확인 (main/preload 변경은 재시작해야 반영됨)
