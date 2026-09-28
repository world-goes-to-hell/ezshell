# 터미널 명령어 히스토리 (연결별)

- 작성일: 2026-09-28
- 상태: 구현 완료. main 쪽 리뷰 반영분(비동기 저장, 키 검증)은 앱 재시작 후 반영

## 요구사항 (사용자 결정 반영)
- 저장 단위: **사이드바에 저장된 연결별**, 앱을 재시작해도 유지. 같은 연결의 탭/분할 창은 히스토리 공유
  - 저장하지 않은 빠른 연결은 `quick:user@host:port` 키로 묶음
- 중복: 같은 명령을 다시 실행하면 새로 쌓지 않고 **맨 위(최신)로 이동**
- 불러오기: **터미널 옆 패널 + 단축키 팝업(Ctrl+Shift+H)** 둘 다
- 항목 선택 시 현재 입력 줄을 그 명령으로 **바꿔서 입력만** 함 (실행은 사용자가 Enter)

## 설계
| 항목 | 결정 | 이유 |
|---|---|---|
| 명령 추출 | Enter(`onData === '\r'`) 시점에 커서 줄(감긴 줄 포함)을 읽고, 처음 나오는 `# ` `$ ` `% ` `> ` `❯ ` 까지를 프롬프트로 제거 | 키 입력 누적은 탭 자동완성, ↑ 셸 히스토리, 백스페이스를 반영하지 못함 |
| 기록 제외 | 대체 화면(vim/less/top), 프롬프트 없는 줄(비밀번호·yes/no 응답), 계속줄 프롬프트(`> `, `-> `, `>>> `: heredoc 본문 등), 빈 명령, 공백으로 시작하는 명령 | 비밀번호 유출 방지, bash `ignorespace` 관례 |
| 저장소 | main `userData/command-history.json`, `{ version, encrypted }` 한 덩어리를 마스터 비밀번호로 암호화 | 명령에 비밀번호가 들어갈 수 있음. sessions.json 과 같은 보호 수준 |
| 쓰기 비용 | main 메모리 캐시 + 1.5초 디바운스 후 `encryptAsync`(스레드 풀 PBKDF2)로 저장, 잠금/종료 시 동기 저장. 저장 세대 번호로 늦게 끝난 비동기 저장이 최신 데이터를 덮지 않게 함 | PBKDF2(10만 회)가 저장마다 수십~백 ms 소요 |
| 중복/상한 로직 | `src/commandHistory.js` (CJS, main 이 require, crypto.js 처럼 out/main/src 로 복사) | main 한 곳에서 처리해 여러 창 동시 기록에도 일관. 순수 함수라 테스트 가능 |
| 동기화 | 변경 시 모든 창에 `command-history-changed` 브로드캐스트 | 경로 즐겨찾기와 같은 패턴 |
| 입력 방식 | `\x05\x15`(줄 끝으로 이동 후 줄 앞부분 삭제) + 명령 | readline(bash/zsh/fish)에서 현재 입력을 교체. ↑ 키와 같은 체감 |
| 상한 | 연결당 500개, 명령 길이 4096자 | 파일 크기와 암호화 비용 제한 |

## 작업
- [x] vitest 개발 의존성 추가, `npm test` 스크립트
- [x] `src/commandHistory.js` + 테스트 (중복 이동, 상한, 검증)
- [x] `src/renderer/lib/commandCapture.ts` + 테스트 (프롬프트 제거, 제외 규칙, 감긴 줄 결합, 입력 문자열 생성)
- [x] main: `command-history-get/add/remove/clear` IPC, 암호화 저장, 디바운스, 잠금·종료 시 flush, 마스터 비밀번호 초기화 시 삭제
- [x] 빌드: 복사 대상에 `commandHistory.js` 추가 (vite 플러그인, `build:copy-extra`)
- [x] preload / types
- [x] `stores/commandHistoryStore.ts` + `hooks/useCommandHistory.ts` (키 조회, 로드, 변경 구독)
- [x] TerminalPanel / SplitTerminal: Enter 시 기록, Ctrl+Shift+H 팝업
- [x] `CommandHistoryPanel` (헤더 버튼, 검색, 복사/삭제/전체 삭제)
- [x] `CommandHistoryPopup` (Fuse.js 검색, ↑↓/Enter/Esc)
- [x] 검증: 테스트, tsc, build, 앱 재시작 후 실제 입력으로 기록·중복·팝업·패널 확인
- [ ] 리뷰 반영분(비동기 저장, 키 검증) 앱 재시작 후 확인

## 알려진 한계
- 줄바꿈이 포함된 붙여넣기처럼 Enter 키 없이 실행된 명령은 기록하지 않음
- 지연이 큰 서버에서 에코가 오기 전에 Enter 를 누르면 끝 글자가 빠질 수 있음
- 프롬프트가 `#$%>❯` 로 끝나지 않는 셸 테마(예: oh-my-zsh robbyrussell `➜`)는 기록되지 않음
- 분리된 터미널 창(TerminalWindow)은 이번 범위에서 기록만 하고 패널/팝업은 제외

## 범위 밖 (발견한 별도 버그)
- 스니펫 삽입, 명령 팔레트 스니펫 실행: `sessionStore.activeSessionId` 가 항상 null
- 통계 대시보드 명령어 수: `useSSH().send` 가 호출되지 않아 항상 0

## 진행 기록

- 2026-09-28 구현 및 실제 앱 검증
  - 기록: `pwd`, `ls`, `echo history-test` 기록, `pwd` 재실행 시 맨 위로 이동(중복 없음), 공백 시작 명령 제외
  - 비밀번호: `read -s` 프롬프트에 입력한 값은 기록되지 않음. 파일은 암호화되어 평문 명령 문자열 없음
  - 패널: 헤더 버튼으로 열림, 최신순 5개 표시 / 팝업: Ctrl+Shift+H, 검색 후 Enter 로 입력만 되고 실행되지 않음, 터미널로 포커스 복귀
  - 팝업 선택 항목이 강조색 배경이라 글자가 안 보이던 문제 → 옅은 강조색 틴트로 변경
- 코드 리뷰 (CRITICAL 0 / HIGH 0 / MEDIUM 2 / LOW 3) 반영
  - [MEDIUM] PS2 계속줄(`> `)을 명령으로 인식해 heredoc 본문이 기록될 수 있음 → 계속줄 프롬프트 제외 + 테스트
  - [MEDIUM] 저장마다 동기 PBKDF2 로 main 프로세스가 멈춤 → `crypto.encryptAsync` 추가, 백그라운드 저장에 사용 + 테스트
  - [LOW] 특수문자/유니코드 사용자명의 빠른 연결은 키 검증에서 조용히 거부 → 공백/제어문자만 거부하도록 완화 + 테스트
  - [LOW, 미반영] 커스텀 프롬프트 테마(`➜`, `λ`)는 기록 안 됨: 알려진 한계
  - [LOW, 미반영] 파일 복호화 실패 시 백업 후 초기화하지만 사용자 알림 없음
- 테스트: 5개 파일 75개 통과
