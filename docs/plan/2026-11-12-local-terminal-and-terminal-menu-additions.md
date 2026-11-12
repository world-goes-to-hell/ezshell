# 로컬 터미널 탭, 터미널 우클릭 메뉴 추가 항목

## 요청
- 탭 줄의 + 메뉴에 "로컬 터미널" 을 추가한다.
- 터미널 우클릭 메뉴에 있으면 편한 기능을 추가한다 (무엇을 넣을지는 맡김).

## 로컬 터미널
- 셸은 main 프로세스가 `node-pty` 로 실행한다 (`src/localShell.js`). Windows 는 PowerShell, 그 밖은 로그인 셸. 시작 폴더는 홈.
- 탭은 `TerminalInfo.local` 로 구분하고 id 는 `local:<번호>` 다. 화면은 `LocalTerminalTab.tsx` (SSH 전용 기능이 많은 `TerminalPanel` 을 쓰지 않는다).
- 탭이 다시 그려져도(패인 분할, 탭 이동) 셸은 유지된다. main 이 셸마다 마지막 256KB 출력을 갖고 있다가 `local-shell-attach` 로 돌려준다.
- 10개까지. 탭을 닫으면 셸을 끝내고, 앱을 종료하면 모두 끝낸다.
- SFTP, 분할, 로그 저장, 탭 복제, 창 분리, 일괄 명령, 연결 수 집계에서는 뺀다 (`lib/sessionTabs.ts` 의 `isSshTab`).
- 보안: IPC 는 본창에서 온 것만 받는다. MCP 도구는 로컬 셸에 닿지 않는다.
- 패키징: `node-pty` 1.1.0 의 사전 빌드(N-API)를 쓴다. `asarUnpack` 에 `node_modules/node-pty/**`, `npmRebuild: false`.

## 우클릭 메뉴 추가 항목
- 맨 위: `모두 선택`
- 편의: `전체 출력 복사`, `출력을 파일로 저장…`
- `스니펫` 하위 메뉴: 저장한 스니펫(15개까지)을 입력줄에 넣는다. 실행하지 않는다.
- 이름 찾기·내용 찾기: 터미널에서 선택한 한 줄 글자를 찾을 말로 채운다.

## 진행
- [x] `src/localShell.js` 와 테스트
- [x] IPC, preload, 타입
- [x] 로컬 터미널 탭, + 메뉴, 시작 화면 버튼
- [x] 우클릭 메뉴 추가 항목 (`terminalMenuCommon.tsx`, `lib/terminalText.ts`)
- [x] 타입 검사, 테스트 2,089개, 빌드
- [x] 실제 앱 확인: 로컬 터미널 14가지(개발 빌드, 패키징된 앱), SSH 탭 메뉴 20가지
- [ ] 스니펫 항목을 눌러 입력되는 것, 찾기 창에 선택 글자가 채워지는 것, 출력 저장 창은 실제 앱에서 누르지 않았다
