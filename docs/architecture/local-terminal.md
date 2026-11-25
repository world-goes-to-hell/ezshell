# Local Terminal Tab (이 PC 의 셸)

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

탭 줄의 + 메뉴와 시작 화면의 `로컬 터미널` 로 이 PC 의 셸을 탭으로 연다. main 이 `node-pty` 로 실행하고(`src/localShell.js`, Windows 는 PowerShell), 탭은 `TerminalInfo.local`, id 는 `local:<번호>`, 화면은 `Terminal/LocalTerminalTab.tsx` 다 (`TerminalPanel` 을 쓰지 않는다). 설계: `docs/plan/2026-11-12-local-terminal-and-terminal-menu-additions.md`.
- 탭이 다시 그려져도(패인 분할, 탭 이동) 셸은 유지된다. main 이 셸마다 마지막 256KB 출력을 갖고 있다가 `local-shell-attach` 로 돌려준다. 화면은 attach 답을 받기 전에 온 출력을 버린다 (그 출력은 답에 이미 들어 있어서 두 번 그려진다).
- 창 자체를 다시 불러오면(개발 서버의 화면 새로 고침, 화면 비정상 종료 뒤) 탭은 모두 사라지지만 셸은 main 에 남는다. 탭으로 되살리기 전에도 실행 중인 에이전트는 메시지 MCP 의 `list_agents` 에 나온다. 첫 잠금 해제 뒤 로컬 탭이 하나도 없으면 `local-shell-list` 로 남은 셸을 받아 탭으로 되살리고, 끝난 셸은 닫는다 (`lib/localShellAdopt.ts`, 탭 제목은 폴더·에이전트에서). 분할한 탭은 칸 배치째 되살린다: 창이 사라질 때(`pagehide`) 탭마다 분할 트리와 칸별 셸 id 를 그 창의 `sessionStorage` 에 적고, 다시 불러온 창이 한 번 읽어 칸에 같은 셸을 붙인다 (`lib/localReloadLayout.ts`). 주 셸이 끝난 탭은 되살리지 않고 남은 셸을 각자 탭으로, 셸이 끝난 칸은 접는다. 채팅 보기였던 칸도 기록해 다시 채팅 보기로 연다. 개발 실행에서는 `preload.js` 가 바뀌면 창을 다시 불러온다. 화면 배치(화면 나누기)는 되살리지 않는다. 화면 테스트 `local-reload`, `local-reload-split`.
- 개발 서버(`electron.vite.config.ts` 의 `server.watch.ignored`)는 `mockups/`·`out/`·`release/`·`dist/`·`e2e/`·`docs/` 를 감시하지 않는다. 감시하는 곳의 `.html` 이 바뀌면 화면 전체를 다시 불러오는데, 다른 세션이 디자인 시안(`mockups/*.html`)을 고치거나 `npm run build` 로 `out/renderer/*.html` 을 다시 쓸 때마다 개발 앱의 탭이 사라졌다.
- 개수 제한은 없다 (예전 문서의 "10개까지" 는 코드에 없었다, 2026-11-24 확인). 탭을 닫으면 셸을 끝내고 앱을 종료하면 모두 끝낸다. SFTP, 로그 저장, 탭 복제, 창 분리, 일괄 명령, 연결 수에서는 뺀다 (분할은 된다: `Split Panes` 절) (`lib/sessionTabs.ts` 의 `isSshTab`, SSH 탭인지 볼 때는 `.db` 만 보지 말고 이 함수를 쓴다).
- Shift+Enter: 그 셸에서 Claude Code·Codex 가 돌 때(메시지 목록의 에이전트)만 `ESC`+`Enter`(`
`)를 보내 줄을 바꾼다 (`lib/agentNewline.ts`). xterm 은 Enter 와 Shift+Enter 를 같은 `
` 로 보낸다. 이 순서는 Claude Code 자체의 `/terminal-setup` 이 Shift+Enter 에 거는 값이고, Codex 0.170.0 도 줄바꿈으로 받는 것을 확인했다. 바꾸면 안 되는 것: 일반 PowerShell 에서는 보내지 않는다 (PSReadLine 에서 ESC 는 입력 중인 줄을 지운다). 화면 테스트 `local-agent-usage`.
- 분할하면 각 칸에 테마 모서리와 1px 카드 테두리가 생긴다 (`LocalTerminalTab.css`). 키보드를 받는 칸은 가장자리의 강조색 2px 선으로 표시한다. 칸 안쪽에 덧그리는 층이라 xterm 크기가 바뀌지 않는다. 상태를 따로 두지 않는다. 화면 시험 `local-split` 에서 구분선 끌기, 손잡이, 빈 자리, Alt 끌기 미리보기도 확인한다.
- 바꾸면 안 되는 것: `local-shell-*` IPC 는 본창에서 온 것만 받는다. MCP 도구나 휴대폰에서 로컬 셸을 직접 열거나 입력하는 경로를 만들지 않는다 (PC 에서 임의 명령을 실행하는 통로가 된다). 휴대폰의 에이전트 글 보내기는 [`Remote Access`](remote-access.md)의 설정과 `chatSend` 규칙을 지난다.
- 패키징: `node-pty` 는 사전 빌드(N-API)를 쓴다. `build.asarUnpack` 의 `node_modules/node-pty/**` 와 `npmRebuild: false` 를 지우지 말 것 (asar 안에서는 셸 실행 파일을 띄울 수 없고, 다시 빌드하려면 Visual Studio 빌드 도구가 필요하다). 새 `src/*.js` 라서 `MAIN_RUNTIME_MODULES` 에 있다.

## 개발 서버 기동 탭

- `src/ipc/localDevelopmentTasks.js`가 워크트리에서 기동 후보를 찾고, 사용자가 고른 ID로 실행 경로와 명령을 main에서 확정한다. 의존성 설치와 sparse checkout 포함은 기존 확인을 거친다. Gradle `bootRun`은 `--no-daemon`을 써서 이미 떠 있는 데몬이 PTY 밖에서 서버를 실행하지 않게 한다.
- `src/localShell.js`는 그 명령만 실행하는 전용 PTY를 연다. Windows는 PowerShell의 일회 실행으로 실제 명령 종료 코드를 전달한다. Unix는 로그인 셸에서 선택한 명령을 `exec`한다. 이 PTY의 실행과 종료 이벤트가 상태 기준이다. 의존성 설치도 같은 실행에 포함되며 포트 응답은 상태 판정에 쓰지 않는다.
- 재기동은 기존 트리를 종료하고 PTY 종료와 발견된 로컬 포트 해제를 확인한 뒤 같은 셸 ID에 새 PTY를 붙인다. 중지는 트리를 종료한다. Windows는 `taskkill /T /F`, Unix는 PTY 프로세스 그룹을 쓴다. 새 ConPTY의 첫 화면 지우기가 이전 출력을 덮기 전에 이전 화면을 스크롤백으로 보낸다. 종료 뒤에도 로그와 탭이 남고, 재기동은 이전에 확인한 실행 설정을 사용한다.
- 바꾸면 안 되는 것. 재기동·중지 IPC는 잠금 해제된 본창의 주 프레임에서만, main에 있는 셸 ID와 그 셸의 기동 ID가 맞을 때 처리한다. 창이 명령이나 실행 경로를 전달하지 못하게 한다. MCP·휴대폰에 이 제어 경로를 노출하면 본창의 실행 권한을 우회할 수 있다.
- `src/ipc/developmentProcess.js`는 로그의 루프백 URL과 프레임워크 시작 포트를 주소 표시용으로 읽는다. 서버 주소를 읽지 못해도 상태·중지·재기동은 동작한다. 창만 다시 불러오면 main에 남은 기동 탭과 로그를 붙인다. 앱 프로세스가 다시 시작된 뒤 저장된 탭은 일반 셸로 복원한다.
