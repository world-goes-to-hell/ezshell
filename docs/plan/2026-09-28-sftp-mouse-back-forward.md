# SFTP 패널 마우스 엄지버튼 뒤로/앞으로 가기

## 목표
SFTP 파일 목록에서 마우스 엄지버튼(뒤로 = button 3, 앞으로 = button 4)을 누르면, 탐색기처럼 이전에 방문한 디렉토리로 이동한다.

## 동작
- 뒤로 버튼: 직전에 방문한 디렉토리로 이동한다. "상위 폴더"가 아니라 방문 기록 기준이다.
- 앞으로 버튼: 뒤로 가기 전에 있던 디렉토리로 다시 이동한다.
- 로컬/원격 목록은 각각 기록을 따로 가지며, 커서가 올라가 있는 목록이 반응한다.
- 새 디렉토리로 이동하면 앞으로 기록은 비워진다. 같은 경로 새로고침은 기록하지 않는다.
- 기록은 최대 50개까지 보관한다. 패널을 닫으면 기록도 사라진다.

## 설계
| 파일 | 역할 |
|------|------|
| `src/renderer/lib/directoryHistory.ts` | 순수 상태 로직(`recordVisit`, `requestStep`) |
| `src/renderer/lib/directoryHistory.test.ts` | 단위 테스트 10건 |
| `src/renderer/hooks/useDirectoryHistory.ts` | 로딩 완료 시점에 경로 기록, 엄지버튼 mouseup 처리 |
| `src/renderer/components/Sftp/FileList.tsx` | 훅 연결 |

- 경로는 로딩이 끝난 뒤(`isLoading === false`)에만 기록한다. SftpPanel은 로딩을 시작할 때 경로를 먼저 바꾸고 실패하면 되돌리는데, 이 방식이면 실패한 이동이 기록에 남지 않는다.
- 뒤로/앞으로 요청은 `pending` 으로만 표시하고, 목표 경로가 실제로 로드된 뒤에 스택을 옮긴다. 로드가 실패하면 스택은 그대로 유지된다.
- Chromium은 엄지버튼 mouseup 시 페이지 history 이동을 기본 동작으로 수행하므로 `mousedown`/`mouseup`/`auxclick` 에서 `preventDefault` 한다.
- 디렉토리 동기화 모드에서는 한쪽의 뒤로 가기가 반대쪽 이동을 유발하고, 반대쪽은 이를 일반 이동으로 기록한다.

## 진행 상황
- [x] 방문 기록 로직 + 단위 테스트 (10 passed)
- [x] 훅 작성 및 FileList 연결 (SftpPanel, SftpWindow 모두 적용)
- [x] `npm run typecheck` 오류 0건, `vitest run` 85 passed
- [ ] 실제 마우스로 동작 확인: 개발 앱 창이 최소화 상태라 CDP 입력이 전달되지 않았고, 사내 서버에 임의로 접속하지 않아 미수행
