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

[로컬 프로젝트 실행 구성](local-project-run.md)
