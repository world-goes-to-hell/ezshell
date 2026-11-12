# ezShell - CLAUDE.md

## Project Overview

Electron 기반 SSH 클라이언트 데스크톱 앱. 한국어 UI.
메인 프로세스(Node.js + ssh2)와 렌더러 프로세스(React + xterm.js + Zustand)로 구성.

## Build & Run

```bash
npm run dev             # 개발 모드 (electron-vite dev)
npm run build           # 번들 빌드 (electron-vite build → out/)
npm run typecheck       # TypeScript 타입 체크 (tsc --noEmit)
npm run build:icon      # assets/icon.svg → assets/icon.ico(16~256px), icon.png (Electron 으로 렌더링)
npm run build:nsis      # 설치형 exe
npm run build:portable  # 포터블 exe
npm run build:publish   # GitHub Releases 배포 (electron-updater)
```

배포 결과물: `release/` 폴더 (electron-builder). `dist/`는 예전 빌드 산출물이다.

실행 중인 앱은 시작 3초 뒤, 30분마다, 창에 다시 포커스가 올 때(10분 간격) 새 버전을 확인한다 (`src/updateChecker.js`). 자동 확인은 새 버전을 찾았을 때만 화면에 알리고, 알림 닫기는 버전 단위다 (`updateStore` 의 `dismissedKey`). 설명: `docs/fix/2026-10-27-update-check-while-running.md`.

## Architecture

### Process Model
- **Main Process** (`main.js`): SSH 연결(ssh2), SFTP, IPC 핸들러, 마스터 비밀번호/암호화, safeStorage
- **Preload** (`src/preload.js`): contextBridge로 `window.electronAPI` 노출
- **Renderer** (`src/renderer/`): React 앱, Vite 빌드

### SSH Data Flow
```
main.js (ssh2 shell) → IPC 'ssh-data' → terminalStore.dispatchSshData()
  → registered handler (per sessionId) → xterm.write()
```

Split 터미널은 별도 IPC 채널 사용: `ssh-split-data`, `ssh-split-send`

### Key Directories
```
main.js                          # Electron 메인 프로세스 (SSH, SFTP, IPC)
src/preload.js                   # IPC 브릿지
src/renderer/
  App.tsx                        # 루트 컴포넌트, 레이아웃 상태 관리
  components/
    Terminal/
      TerminalPanel.tsx          # 메인 터미널 (xterm 인스턴스 관리)
      SplitTerminal.tsx          # 분할 터미널 (독립 SSH 쉘 채널)
      FileExplorer.tsx           # SFTP 파일 탐색기
      SplitPaneTabBar.tsx        # 분할 패인 탭 바
      TerminalWindow.tsx         # 분리된 터미널 창
    LockScreen/LockScreen.tsx    # 마스터 비밀번호 잠금 화면
    Sidebar/                     # 세션 목록, 폴더 관리
    Sftp/                        # SFTP 패널
    Settings/                    # 앱 설정
    Modal/                       # 연결 모달 등
    CommandPalette/              # 명령 팔레트
    Snippets/                    # 스니펫 관리
  stores/
    terminalStore.ts             # 터미널 상태, SSH 데이터 핸들러, 분할 관리
    sessionStore.ts              # 세션 저장/로드
    sftpStore.ts                 # SFTP 상태
    themeStore.ts                # 테마 관리
    uiStore.ts                   # UI 상태
  styles/
    globals.css                  # 전역 스타일 (매우 큰 파일)
    variables.css                # CSS 변수 (색상, 테마)
```

### State Management (Zustand)
- `terminalStore.ts`: 핵심 스토어. 터미널 생성/삭제, SSH 데이터 핸들러 등록/해제, 분할 관리
- `sshDataHandlers`: Map<sessionId, handler> - 터미널별 SSH 데이터 수신 핸들러
- `sshDataBuffers`: 핸들러 미등록 시 데이터 버퍼링 (언마운트/리마운트 전환 중 데이터 보존)

### Two Split Systems
1. **Per-Terminal Split** (TerminalPanel 내부): `SplitTerminal`로 추가 쉘 채널 생성. `SplitDirection = 'horizontal' | 'vertical' | 'quad'`
2. **Pane-Level Split** (App.tsx): `LayoutState`로 primary/secondary 패인 관리, 탭 드래그로 활성화

## Important Patterns

### React Tree Restructuring
App.tsx에서 single → split 모드 전환 시 TerminalPanel이 React 트리에서 이동하면서 unmount/remount 발생.
- xterm 인스턴스 dispose 후 재생성
- SSH 데이터 핸들러 해제 후 재등록
- `sshDataBuffers`로 전환 중 데이터 손실 방지

### SSH Channel Open Failure
분할 터미널 생성 시 이전 스트림이 완전히 닫히지 않으면 서버가 새 채널 거부.
- main.js `ssh-create-shell`에서 실패 시 해당 세션의 모든 stale split 스트림 자동 정리 후 재시도
- SplitTerminal에서 exponential backoff 자동 재시도 (최대 3회)

### SplitTerminal Key Stability
모든 SplitTerminal은 `.terminal-split-container` 바로 아래, 같은 트리 레벨의 안정적 key 감싸개(`w-split-1/2/3`) 안에서 렌더링한다.
2분할(horizontal/vertical) 패널도 별도 요소가 아니라 `w-split-1` 이다 (2분할은 flex 비율, quad/tri 는 grid 위치 스타일만 다름).
그래서 2분할 ↔ quad/tri, quad ↔ tri 전환 모두 남는 패널의 셸이 유지된다.
감싸개를 조건부 Fragment 안에 따로 두면 key 가 같아도 부모가 달라 React 가 새로 만들고, 기존 분할 셸이 닫힌다 (2026-10-01 수정한 버그).

### Terminal Right-Click Menu
터미널(탭의 주 터미널과 분할 셸)에서 우클릭하면 메뉴가 뜬다 (`Terminal/useTerminalContextMenu.tsx`, `TerminalContextMenu.tsx`). 맨 위에 복사·붙여넣기·모두 선택, 그 아래 `분할`(좌우·상하·4분할·해제), `편의`(이름 찾기, 내용 찾기, 화면에서 찾기, 화면 지우기, 전체 출력 복사, 출력을 파일로 저장, 파일 탐색기), `스니펫`(저장한 스니펫 15개까지를 입력줄에 넣음, 실행하지 않음), `세션`(탭 복제, 로그 저장, SFTP, 연결 종료) 하위 메뉴가 있다. 포인터 위치에 빈 기준점을 두고 여는 Radix DropdownMenu 이다 (modal 아님: 다른 곳을 우클릭하면 메뉴가 옮겨 간다).
- 복사·붙여넣기·화면 지우기·찾기는 우클릭한 그 터미널에 적용한다. 터미널마다 그려지는 요소를 `lib/terminalPanes.ts` 에 등록해 두고 `terminalPaneAt` 으로 찾는다. 터미널 영역 위에 그려지는 패널(포트 포워딩 등)에서는 메뉴를 띄우지 않는다.
- 이름 찾기·내용 찾기(`TerminalFindDialog.tsx`, 명령 생성은 `lib/terminalFind.ts`)는 `find` / `grep -rnIF` 명령을 만들어 `terminal.paste` 로 입력줄에 넣는다. 찾을 위치는 현재 폴더(`.`), 루트(`/`, `/proc` `/sys` `/dev` 제외), 폴더 지정 중에서 고르고 `localStorage` 의 `terminalFindPrefs` 에 기억한다.
  - 바꾸면 안 되는 것: 앱이 명령을 실행하지 않는다 (줄바꿈을 붙이지 않고, 사용자가 Enter 를 누른다). 큰 폴더 검색은 운영 서버 디스크를 오래 읽는다. 입력값은 작은따옴표로 감싸고, 줄바꿈·제어 문자는 앞뒤 공백을 자르기 전에 거부한다 (줄바꿈이 들어가면 입력되는 순간 앞부분이 실행된다).
- 복사·붙여넣기·모두 선택과 화면 지우기·출력 복사·출력 저장은 `terminalMenuCommon.tsx` 에 있고 로컬 터미널 탭도 같은 항목을 쓴다. 출력 글자는 `lib/terminalText.ts` 가 버퍼에서 읽는다 (너비에서 접힌 줄은 한 줄로 잇는다). 찾기 창은 터미널에서 선택한 한 줄 글자를 찾을 말로 채운다.
- 탭 복제는 `ezshell:duplicate-tab` 이벤트로 `App.tsx` 에 넘긴다 (복제 로직이 App 에 있다).
- 시험할 때: 하위 메뉴는 포인터가 지나온 경로로 열림 유지를 판단한다. CDP 로 포인터를 한 번에 옮기면 하위 메뉴가 닫히므로 여러 번에 나눠 움직인다.

### Local Terminal Tab (이 PC 의 셸)
탭 줄의 + 메뉴와 시작 화면의 `로컬 터미널` 로 이 PC 의 셸을 탭으로 연다. main 이 `node-pty` 로 실행하고(`src/localShell.js`, Windows 는 PowerShell), 탭은 `TerminalInfo.local`, id 는 `local:<번호>`, 화면은 `Terminal/LocalTerminalTab.tsx` 다 (`TerminalPanel` 을 쓰지 않는다). 설계: `docs/plan/2026-11-12-local-terminal-and-terminal-menu-additions.md`.
- 탭이 다시 그려져도(패인 분할, 탭 이동) 셸은 유지된다. main 이 셸마다 마지막 256KB 출력을 갖고 있다가 `local-shell-attach` 로 돌려준다. 화면은 attach 답을 받기 전에 온 출력을 버린다 (그 출력은 답에 이미 들어 있어서 두 번 그려진다).
- 10개까지. 탭을 닫으면 셸을 끝내고 앱을 종료하면 모두 끝낸다. SFTP, 분할, 로그 저장, 탭 복제, 창 분리, 일괄 명령, 연결 수에서는 뺀다 (`lib/sessionTabs.ts` 의 `isSshTab`, SSH 탭인지 볼 때는 `.db` 만 보지 말고 이 함수를 쓴다).
- 바꾸면 안 되는 것: `local-shell-*` IPC 는 본창에서 온 것만 받는다. MCP 도구가 로컬 셸에 닿는 경로를 만들지 않는다 (PC 에서 임의 명령을 실행하는 통로가 된다).
- 패키징: `node-pty` 는 사전 빌드(N-API)를 쓴다. `build.asarUnpack` 의 `node_modules/node-pty/**` 와 `npmRebuild: false` 를 지우지 말 것 (asar 안에서는 셸 실행 파일을 띄울 수 없고, 다시 빌드하려면 Visual Studio 빌드 도구가 필요하다). 새 `src/*.js` 라서 `MAIN_RUNTIME_MODULES` 에 있다.

### Sidebar Tree and Folded Rail
사이드바 목록 모양은 `Sidebar/SidebarTree.css` 에 있다. 줄에는 배경색을 칠하지 않는다: 폴더 색은 폴더 왼쪽의 선 하나(`--folder-color`), 세션 자체 색은 줄 옆의 짧은 선(`--session-color`)이다. 기본 아이콘 자리에는 상태 점(`.session-dot`, 연결된 탭이 있으면 초록, 끊긴 탭만 있으면 빨강)을 둔다. 세션 이름은 입력한 그대로 보여 준다.
접힌 상태(`sidebarMode === 'compact'`, 클래스 `.sidebar.rail`)는 46px 띠에 버튼과 세로 글자 "세션", 연결된 탭 수(`.rail-session-summary`)만 보이고 목록은 그리지 않는다 (이름 없는 화살표·점만 줄지어 있어 알아볼 수 없었다), 마우스를 올리거나 키보드 포커스가 들어오면 전체 사이드바가 터미널 위로 겹쳐서 열린다 (`hooks/useSidebarPeek.ts`, `.peek-open`, 자리를 차지하지 않으므로 터미널 크기가 바뀌지 않는다). 사이드바의 메뉴·호버 카드·이름 입력칸을 쓰는 동안에는 닫지 않는다. 줄임말 타일은 없앴다 (사용자가 원하지 않았다). 띠와 열린 상태는 같은 DOM 이고 CSS 로만 다르다.
접기 버튼은 상태마다 아이콘이 다르다 (펼침 `«`, 띠 `»`, 겹쳐 열림은 핀). 아이콘을 돌리는 애니메이션을 다시 넣지 말 것: 좌우 대칭 아이콘을 180도 돌리면 두 상태가 같은 모양이 된다.

### Sidebar Session Tab Badge
사이드바 세션 옆에 그 세션에서 열린 탭 개수를 배지로 표시한다 (초록 테두리 = 연결됨, 빨강 테두리 = 끊김, 섞이면 둘 다).
탭 ID 는 메인 프로세스가 연결마다 만드는 값이라 사이드바 세션 ID 와 다르다. 둘은 `TerminalInfo.connectConfig.savedSessionId` 로만 이어진다 (`lib/sessionTabs.ts`).
배지의 탭이 1개면 바로 이동, 2개 이상이면 목록에서 고른다. 이동은 `terminalStore.focusTerminal` 을 쓴다 (분할 유지, 터미널에 키보드 포커스).
별도 창으로 분리한 탭과 저장하지 않은 빠른 연결은 세지 않는다.
세션 행이 Tooltip Trigger 라서 배지/목록의 이벤트가 포털을 통과해 행까지 올라간다. 처리 내용은 `docs/brain/2026-10-01-react-events-bubble-through-portals-into-tooltip-trigger.md` 참고.

### App Name and User Data Folder
앱 이름은 `ezShell` (이전 이름 `My SSH Client`). Electron 사용자 데이터 폴더는 앱 이름을 따르므로,
`main.js` 시작 부분에서 `src/userDataDir.js` 로 옛 폴더(`%APPDATA%\my-ssh-client`)가 있으면 그 폴더를 계속 쓴다.
폴더 이름은 `build.productName` 이 아니라 package.json `name` 을 따른다 (패키징된 package.json 에 productName 이 없음). 설치본과 dev 가 같은 폴더를 쓴다.
`appId`(`com.sungkwan.ssh-client`)는 바꾸지 않는다. 바꾸면 설치형이 다른 앱으로 인식된다.

### App Icon
원본은 `assets/icon.svg`, `npm run build:icon` 으로 icon.ico/icon.png 를 만든다 (`scripts/build-icon.cjs`, ICO 작성은 `scripts/ico.cjs`).
exe 아이콘은 `build.win.signAndEditExecutable: true` 일 때만 들어간다 (false 면 Electron 기본 아이콘).
창/작업표시줄 아이콘은 빌드 때 `out/main/icon.ico` 로 복사되고 모든 BrowserWindow 의 `icon` 으로 지정된다.
타이틀바 왼쪽 아이콘은 같은 명령이 만드는 `src/renderer/assets/app-icon.svg`(작은 크기용, 직접 수정 금지)를 `?no-inline` 으로 불러온다.
작은 SVG 가 data: URL 로 인라인되면 페이지 CSP(`default-src 'self'`)에 막히기 때문이다.

### MCP Server (Claude Code)
`src/mcp/` 에 로컬 MCP 서버가 있다. Claude Code 에 등록되는 이름은 `ez-shell` 이다 (도구는 `mcp__ez-shell__...`). 2.4.1 까지는 `my-ssh-client` 였고, "Claude Code 자동 설정"이 같은 파일의 옛 이름 항목을 지우고 새 이름으로 바꾼다 (`controller.js` 의 `LEGACY_SERVER_NAMES`). `~/.claude.json` 의 프로젝트별 등록은 고치지 않고 화면에 알려 주기만 한다. 설정 > MCP 에서 켜면 `127.0.0.1:<포트>/mcp` (Streamable HTTP, stateless) 로 열린다.
- 도구: `list_sessions`, `cd`, `run_command`, `write_file`, `edit_file`, `upload_file`, `download_file`, `job_output`, `stop_job`, `list_jobs`. 세션 편집 > 고급 설정의 "MCP 접근 허용"(`mcpEnabled`)을 켠 세션만 보인다. 사이드바 세션 우클릭 메뉴의 `MCP 접근 허용` 으로도 같은 값을 켜고 끄며, 켠 세션은 목록에 플러그 표지(`.session-mcp-mark`)가 붙는다.
- 파일 쓰기(`write_file`, `edit_file`, `fileTools.js`)는 셸을 거치지 않고 SFTP 로 한다. 알림 수준과 무관하게 항상 확인 창을 띄우고, 창에는 명령 대신 변경 내용(diff)과 실제 경로(심볼릭 링크를 푼 경로)를 보여 준다. 제한 시간은 180초. 허용한 뒤 파일이 확인 창에 보여 준 내용과 달라졌으면 쓰지 않는다(`remoteFile.js` 의 `writeIfUnchanged`). 기존 파일은 같은 파일에 덮어써서 소유자·권한을 유지하고, 실패하면 이전 내용으로 되돌린다. 256KB·10,000줄 이하 UTF-8 텍스트만, 접속 계정 권한으로만 쓴다. 감사 로그에는 도구 이름, 경로, 승인 여부, 내용의 SHA-256 만 남고 내용은 남지 않는다. 설계와 보안 검토 반영: `docs/plan/2026-10-02-mcp-file-tools-design.md`.
  - 바꾸면 안 되는 것: 덮어쓰기는 파일을 `r+` 로 한 번 열어 그 핸들의 내용을 비교하고 같은 핸들에 쓴다 (경로를 다시 여는 방식으로 바꾸면 그 사이에 링크로 바뀐 경로를 따라간다). 읽기는 핸들에서 256KB+1 까지만 한다 (`readFile` 은 크기 0 으로 보이는 파일을 끝없이 읽는다). `/proc`, `/sys`, `/dev` 는 거부한다.
  - diff 계산(`fileEdit.js`)은 300ms 제한이 있고, 넘으면 전체 교체로 표시한다. 제한을 없애면 줄이 많은 입력에 main 프로세스가 멈춘다.
  - `cat` 으로 읽을 때 확인이 필요한 알림 수준·경로에서는 `edit_file` 을 거부한다 ("찾지 못함" 같은 답으로 내용을 추정할 수 있어서).
  - 확인 창의 "허용"은 창이 뜬 뒤 0.8초, 그리고 변경 내용을 끝까지 내려 보기 전에는 눌리지 않는다.
- 확인 창(`McpApprovalDialog.tsx`)은 두 버튼과 제한 시간으로만 끝난다. 바깥 클릭과 Esc 로는 닫히지 않고, 처음 포커스는 버튼이 아니라 창 자체다. 두 버튼 모두 앱 창에 포커스가 있고, 창이 뜬 때와 포커스를 받은 때 중 늦은 쪽부터 0.8초가 지나야 눌린다 (`lib/approvalArming.ts`). 바꾸면 안 되는 것: 앱 창은 포커스 없이 올라오므로 앞으로 가져오는 첫 클릭과 다른 곳에 치던 키가 응답이 되면 안 된다 (`docs/fix/2026-10-26-mcp-approval-accidental-deny.md`).
- 백그라운드 작업(`run_command` 의 `background: true`, `job_output`, `stop_job`, `list_jobs`)은 30초를 넘는 명령을 위한 것이다. main 이 실행 채널을 요청과 분리해 붙잡고(`jobChannel.js`), 출력은 메모리에만 둔다(`jobStore.js`, 작업당 마지막 1MB). 판정은 `run_command` 와 같은 경로(`tools.js` 의 `guarded`)를 지나고, 알림 수준과 무관하게 항상 확인 창을 띄워 "백그라운드 실행 · 최대 N분" 을 보여 준다 (낮음 명령도 한 시간 동안 돌 수 있어서). 기본 10분·최대 60분, 세션당 3개·전체 6개, 총 출력이 16MB 를 넘으면 중지한다. 앱을 잠그거나 MCP 를 끄면 모든 작업을 중지하고 목록을 지운다 (앱을 닫아도 이어지는 작업은 일부러 만들지 않았다). 설계: `docs/plan/2026-10-02-mcp-background-jobs-design.md`.
  - 바꾸면 안 되는 것: 작업 스크립트의 첫 줄이 셸 PID 를 stderr 로 알리고, 중지할 때 시그널 요청에 더해 `kill -KILL -- -<PID>` 를 보낸다. OpenSSH 7.9 미만은 시그널 요청을 무시하고, 채널만 닫으면 프로세스가 서버에 남는다 (실제 sshd 로 확인함). PID 가 1 이하면 버린다 (`kill -- -1` 은 계정의 모든 프로세스를 죽인다).
  - 작업이 끝났다는 보고(`done`)는 kill 명령이 끝난 뒤에 한다. 잠글 때는 작업이 끝나는 대로 연결을 닫으므로, 먼저 보고하면 kill 이 서버에 도착하기 전에 연결이 닫힌다. 같은 이유로 PID 줄을 받기 전에는 채널을 닫지 않고(최대 1초 기다림), 작업은 채널을 요청하는 순간부터 그 연결의 작업으로 세며, 앱 종료는 작업이 있으면 `shutdown()` 이 끝날 때까지 기다린다 (`main.js` 의 `before-quit`).
  - 출력은 50ms 마다 묶어서 넘긴다 (`jobChannel.js` 의 `createBatcher`). 묶지 않으면 한두 바이트씩 내는 명령이 이벤트마다 보관 버퍼를 복사하게 해서 main 프로세스가 멈춘다. 활동 출력의 조각 수 제한(2,000개)도 같은 이유다.
  - 시작된 작업은 그 작업을 시작한 요청의 신호로 멈추지 않는다 (요청이 끝난 뒤에도 실행되어야 한다). 멈추는 것은 활동 패널의 "중지", `stop_job`, 제한값, 잠금뿐이다.
  - 세션을 저장하면 연결을 바로 닫지 않고 떼어 낸다(`retireAll`). 새 요청은 새 설정으로 다시 접속하고, 작업이 있는 옛 연결은 작업이 끝나면 닫힌다. 허용이 꺼진 세션의 작업은 중지한다.
  - `job_output` 은 작업이 끝나기를 `wait_seconds` 만큼 기다린 뒤 그동안의 출력을 모아서 준다. 출력이 나올 때마다 돌려주면 Claude 가 줄마다 호출한다 (43초 작업에 41번 호출됐었다).
  - 활동 목록은 100개를 넘으면 끝난 요청부터 버린다. 실행 중인 요청을 버리면 그 요청의 "중지" 버튼이 사라진다. 요청당 출력은 마지막 512KB 만 둔다 (main 과 렌더러가 같은 값).
- 파일 전송(`upload_file`, `download_file`, `transferTools.js`)은 PC 와 서버 사이에서 파일 하나(1GB 까지, 바이너리 포함)를 옮긴다. 앱이 PC 의 파일을 읽고 쓰는 유일한 MCP 도구다. 설정 > MCP 의 "파일 전송 허용 폴더"(`mcp.json` 의 `transferRoots`, 기본은 빈 목록) 안에서만 동작하고, 알림 수준과 무관하게 항상 확인 창(방향, 양쪽 실제 경로, 크기, 60초)을 띄운다. 받는 쪽에는 `.<이름>.ezshell-part-<난수>` 임시 파일로 쓰고 다 끝난 뒤 이름을 바꾼다. 20초 안에 끝나지 않으면 기존 작업(job)으로 넘어가 `job_output` / `stop_job` 으로 다루고, 제한은 60분이다. 감사 로그에는 양쪽 경로, 크기, 승인 여부, SHA-256 만 남는다. 설계와 보안 검토 반영: `docs/plan/2026-10-13-mcp-file-transfer-design.md`.
  - 바꾸면 안 되는 것: 전송 폴더는 main 의 폴더 선택 창으로만 추가한다 (`mcp-add-transfer-folder` 는 경로를 인자로 받지 않고, `mcpConfig` 의 일반 `update` 는 `transferRoots` 를 거부한다). 앱 데이터 폴더를 포함하는 폴더는 등록할 수 없다.
  - PC 경로 판정(`localPath.js`)은 글자만 보고 폴더 밖이면 파일 시스템을 건드리지 않고 거부한 뒤, 실제 경로로 다시 본다. 등록 폴더는 실제 경로로 저장하고, 지금 풀어 본 경로가 저장값과 다르면 무시한다 (폴더를 지우고 같은 이름의 정션을 만들면 정션이 가리키는 곳이 허용 범위가 된다). 디스크를 본 뒤의 거부는 모두 같은 문구다 (정션으로 임의 경로의 존재 여부를 알아낼 수 있어서).
  - 올리는 PC 파일은 확인 창 전에 한 번 열고 그 핸들만 읽는다. 연 뒤에 경로를 다시 풀어 파일 ID 가 같은지 보고, 이름이 둘 이상인 파일(하드 링크)은 거부한다 (경로 검사를 모두 통과하면서 내용은 폴더 밖 파일이다).
  - 전송은 세션의 명령 대기열과 별도의 SFTP 채널(`sessionGateway.openTransfer`)을 쓰고, 작업처럼 그 연결의 작업으로 센다. 임시 파일 정리가 끝난 뒤에 작업 종료를 보고한다 (먼저 보고하면 잠글 때 정리 전에 연결이 닫힌다).
  - 서버의 기존 파일 덮어쓰기는 `posix-rename` 확장이 있어야 한다. 없으면 거부하고, 지우고 다시 쓰는 방식으로 바꾸지 않는다 (중간에 끊기면 원래 파일을 잃는다).
- 호스트 주소와 계정은 Claude 에게 넘기지 않는다. 대신 `list_sessions` 가 `server` 표지(`서버-1`, ...)를 붙여 같은 서버에 접속하는 세션을 알려 준다 (호스트+포트, 점프 호스트를 쓰면 그 주소까지 같아야 같은 서버). 표지는 목록 순서 번호이고 주소의 해시가 아니다 (IP 해시는 역산할 수 있음).
- 명령은 `commandPolicy.js` 가 낮음/중간/위험/절대 차단으로 판정한다. 처음 보는 명령은 위험. 위험은 항상 앱 확인 창(60초 안에 응답 없으면 거부), 절대 차단은 실행 불가.
- `run_command`, `cd` 는 `reason`(요청 사유)을 받는다. 확인 창이 필요한 명령인데 사유가 없으면 창을 띄우지 않고 거부한다 (감사 로그에도 남기지 않음). 사유는 한 줄로 정리해 500자까지 쓰고, 확인 창에 "Claude 가 직접 적은 설명" 이라는 안내와 함께 보여 준다. 판단 기준은 명령이다 (사유는 거짓일 수 있음). Windows 알림에는 넣지 않는다. 설계: `docs/plan/2026-10-23-mcp-command-reason.md`.
- 설정은 `userData/mcp.json`(main 전용), 감사 로그는 `userData/mcp-audit.log`(명령, 판정, 요청 사유만. 출력은 기록하지 않음).
- 상태바의 "MCP 활동" 패널이 요청과 상태(대기/실행/완료/거부/취소/차단)를 실시간으로 보여준다. 이 목록과 명령 출력은 메모리에만 있고 디스크에 쓰지 않는다 (출력에 비밀이 섞일 수 있음).
- 패널에는 `목록 | 터미널` 두 보기가 있다 (기본은 터미널). 터미널 보기(`McpActivityTerminal.tsx`)는 명령과 출력을 시간순으로 잇는 읽기 전용 화면이고 xterm 이 아니다. 실행 중 출력은 `sessionGateway` 의 `onOutput` → `activityLog.appendOutput`(50ms 묶음) → `mcp-activity-output` 채널로 온다. 요청이 끝날 때 오는 `mcp-activity` 항목이 `outputParts` 전체를 담고 있어 그쪽이 기준이다. 실행 중에도 `update` 로 항목을 보내면 그 요청의 대기 중인 출력 묶음은 버린다 (창이 항목으로 사본을 바꾸므로, 묶음까지 보내면 줄이 두 번 보인다. `docs/fix/2026-11-05-mcp-transfer-progress-line-twice.md`). 탭으로 만들지 않은 이유: 탭은 모두 SSH 연결 하나를 전제로 한다.
- 세 번째 보기 `서버별`(`McpActivityLanes.tsx`)은 세션마다 영역을 나눠 같은 형식의 기록을 보여 준다 (`lib/mcpActivity.ts` 의 `groupBySession`). 영역마다 스크롤이 따로이고, 영역 순서는 첫 요청 순서로 고정이다 (활동 때마다 바꾸면 읽던 영역이 움직인다). 기준은 서버 주소가 아니라 세션이고, 요청을 보낸 에이전트는 구분하지 못한다 (stateless, 토큰 하나).
  - 영역 머리줄의 X 로 영역을 숨긴다. 숨길 때의 가장 최근 요청 ID 를 기억하고(`mcpActivityStore` 의 `hiddenLanes`, 판정은 `lib/mcpActivity.ts` 의 `isLaneHidden`), 그 세션에 새 요청이 오면 다시 보인다. 이미 있던 요청의 출력·상태 변화로는 다시 뜨지 않는다. 메모리에만 두고 목록을 지우면 함께 지운다. 상단 막대의 "모두 보기" 로 되돌린다. 설계: `docs/plan/2026-10-24-mcp-lane-hide.md`.
- 패널은 `z-index: 95` 다. 터미널·SFTP 위, 대화상자(100)·메뉴(1000)·업데이트 알림(900)·안내(9999) 아래다. 다시 높이지 말 것: 9200 이던 때 업데이트 알림과 대화상자가 패널 뒤에 가려졌다 (`docs/fix/2026-10-26-mcp-panel-layer-and-host-key-message.md`).
- 패널이 열린 채로 앱 화면(`#root`)의 다른 곳(셸, SFTP, 사이드바)을 누르면 패널이 오른쪽으로 밀려 36px 띠만 남는다 (`lib/mcpActivity.ts` 의 `collapsesMcpPanel`, 캡처 단계 `pointerdown`). 누른 동작은 셸로 그대로 간다. 확인 창·메뉴처럼 `#root` 밖에 그려지는 것과 알림은 접지 않는다. 띠나 상태바 버튼을 누르면 펼친다 (`togglePanel`). 접힌 동안 내용은 마운트된 채 `inert` 이고(스크롤 유지), Esc 로 닫지 않는다 (셸의 Esc). 설계: `docs/plan/2026-10-24-mcp-panel-collapse.md`.
- 서버별 보기의 영역은 머리줄을 끌어서 순서를 바꾼다 (HTML5 끌기, 형식 `application/x-ezshell-mcp-lane` 만 받음). 순서는 `mcpActivityStore` 의 `laneOrder`(메모리)이고 `lib/mcpActivity.ts` 의 `orderLanes`, `moveLane` 이 계산한다. 처음 보는 세션은 끝에 붙는다. 개별 기록은 시간순이라 옮기지 않는다.
- 파일 전송 요청은 활동 항목의 `transfer`(방향, 크기, 보낸 크기, 복사 시작 시각)로 진행 막대를 그린다 (`McpTransferBar.tsx`, 계산은 `lib/mcpTransfer.ts`). `transferTools.js` 가 1초마다 갱신하며 감사 로그에는 넣지 않는다. 속도는 복사 시작부터 센다 (확인 창 대기 시간 제외).
- 패널 머리줄의 "새 창으로 열기" 로 MCP 활동 창(`?mcpActivityMode=true`, `McpActivityWindow.tsx`, 패널의 `window` 형태)을 연다. 창은 하나이고 main 의 `sendToActivityViews` 가 활동 갱신을 본창과 이 창에 보낸다. 앱을 잠그면 닫고, 잠긴 동안에는 열 수 없다 (명령 출력이 잠금 화면 뒤에 남지 않게). 확인 창은 본창에만 뜬다. 설계: `docs/plan/2026-10-24-mcp-activity-window-progress-reorder.md`.
- 터미널·서버별 보기의 명령 줄은 `lib/shellFormat.ts` 가 `;` `&&` `|` 마다 줄을 나누고 색을 입혀 보여 준다 (`sh -c '...'` 안 스크립트는 한 단계 더 들여씀). 표시만 바꾸고, 감사 로그·실행은 원문이다. 확인 창(`McpApprovalDialog`)도 같은 정렬로 보여 주되(`ShellCommandText.tsx`), `원문 보기` 로 바꿀 수 있고, 정렬 결과에서 공백을 뺀 글자가 원문과 다르면 원문만 보여 준다 (`isFaithfulLayout`, 바꾸면 안 되는 것: 판단하는 화면이 실행될 명령과 다른 글자를 보여 주면 안 된다). 연산자를 줄 끝에 두어 복사해도 같은 뜻으로 실행된다. heredoc 은 여는 줄까지만 나누고(그 줄의 `<<EOF` 뒤로는 나누지 않음) 본문은 글자 그대로 두며 문자열·주석·키워드에만 색을 입힌다. 끝 줄 없는 heredoc·닫히지 않은 따옴표는 원문 그대로 둔다. 설계: `docs/plan/2026-11-03-mcp-activity-command-layout.md`.
- 시작한 지 3초가 지나도 진행 중인 요청은 패널 위에 고정한다 (`McpPinnedRequests.tsx`, 계산은 `lib/mcpPinned.ts`). 터미널·목록 보기는 기록 위, 서버별 보기는 영역마다 위에 둔다. 카드는 명령 한 줄(길면 말줄임), 접기/펼치기, 출력 마지막 3줄이고 오래 실행된 순서다. 기록에서는 빼지 않는다 (전체 출력은 기록에서 본다). 3초 기준을 없애면 바로 끝나는 명령마다 카드가 나타났다 사라져 기록이 흔들린다. 설계: `docs/plan/2026-11-02-mcp-activity-pinned-requests.md`.
- 선택한 보기와 서버별 보기의 `작업 중만` 값은 `localStorage` 의 `mcpActivityPrefs` 에 남는다 (`lib/mcpActivity.ts` 의 `parseActivityPrefs`). 요청과 출력은 저장하지 않는다.
- 확인 창이 뜰 때 앱 창에 포커스가 없으면 작업표시줄을 깜빡이고 Windows 알림을 띄운다 (`main.js` 의 `alertMcpApproval`). 알림에는 요청 종류(`approvalNotice.js`), 세션 이름, 위험도만 넣는다. 알림은 알림 센터에 남으므로 명령과 경로는 넣지 않는다.
- 확인 창이 떠 있는 동안 본창은 "항상 위" 이고, 최소화되어 있으면 복원된다 (`main.js` 의 `keepMainWindowOnTop`). 확인이 어떻게 끝나든 브로커의 `onClose` 로 풀린다. 가려져 있던 창은 `moveTop` 만으로는 Chromium 이 다시 그리지 않으므로 `showInactive()` 를 항상 부른다 (`docs/brain/2026-10-26-electron-occluded-window-not-repainted-after-raise.md`). 포커스는 가져오지 않는다: 다른 프로그램에 입력하던 Enter·Esc 가 확인 창의 응답이 되면 안 된다. 설계: `docs/plan/2026-10-19-mcp-approval-window-on-top.md`.
- 설정 > MCP 의 "Claude Code 자동 설정"(`clientSetup.js`): 프로젝트는 고른 폴더의 `.mcp.json` 에 토큰 대신 `${EZSHELL_MCP_TOKEN}` 참조를 쓰고(Windows 는 `tokenEnv.js` 가 PowerShell 절대 경로로 사용자 환경 변수 설정. 토큰은 명령줄이 아니라 stdin 으로 넘기고, 오류 메시지에 명령줄이 섞이지 않게 한다), 전체는 `~/.claude.json` 의 `mcpServers` 에 토큰을 직접 쓴다. 다른 항목은 보존하고 `<파일>.ezshell-backup` 으로 백업하며, 깨진 JSON 은 거부하고, 같은 이름 항목은 확인 후 덮어쓴다. 폴더는 main 의 선택 창으로만 고른다.
- Electron 28(Node 18)에는 `globalThis.crypto` 가 없어서 `src/mcp/sdk.js` 가 채운 뒤 SDK 를 불러온다.
- `src/mcp` 는 번들되지 않고 `electron.vite.config.ts` 가 `out/main/src/mcp` 로 복사한다.

### Session Log (터미널 출력을 파일로 저장)
탭 우클릭 메뉴 또는 명령 팔레트의 `로그 저장 시작/중지` 로 켜고 끈다. 기록 중인 탭에는 붉은 점이 붙는다 (`.tab-log-indicator`).
- 파일: `문서\ezShell Logs\<세션 이름>_<YYYYMMDD-HHmmss>.log`. 이름은 `logFile.js` 의 `safeFileName` 이 경로 문자를 `_` 로 바꾸고, 파일은 `wx` 로 열어 덮어쓰지 않는다.
- main 프로세스가 기록한다 (`src/sessionLog/`). SSH 스트림의 data 이벤트에서 `sessionLogger.write` 를 부르고, 로그의 어떤 실패도 터미널로 가는 데이터를 막지 않는다.
- 터미널 해석은 `@xterm/headless` 에 맡기고 줄바꿈이 처리될 때 완성된 줄을 읽는다 (`lineRecorder.js`). 전체 화면 프로그램 구간은 표시 한 줄만 남긴다. 직접 만든 필터로 바꾸지 말 것: 너비를 넘는 명령줄과 두 칸 글자에서 깨진다 (`docs/brain/2026-10-02-xterm-headless-wide-char-wrap-padding.md`).
- 탭의 주 터미널만 기록한다 (탭 안 분할 셸 제외). 자동 재연결되면 같은 파일에 이어 쓰고, 탭을 닫거나 연결이 완전히 끊기면 끝낸다.
- 출력된 내용은 평문으로 남는다 (`cat .env` 의 결과도). 그래서 사용자가 켠 탭만 기록한다.
- `src/sessionLog` 는 번들되지 않고 `electron.vite.config.ts` 가 `out/main/src/sessionLog` 로 복사한다.

### Root Switch (로그인 후 su -)
세션 편집 > 고급 설정의 "로그인 후 root 로 전환"(`suRoot`, `suPassword`)을 켜면 셸이 열린 뒤 main 이 `su -` 를 보내고 비밀번호를 넣는다 (`src/rootSwitch.js` 의 `switchToRoot`). `ssh-connect` 는 전환이 끝난 뒤 답하므로 자동 실행 스크립트는 root 로 실행된다. 자동 재연결·재연결 버튼 뒤에도 다시 전환한다. 결과(`switched`/`failed`/`no-prompt`/`unknown`)만 렌더러로 가고 알림은 `lib/rootSwitch.ts`. 설계: `docs/plan/2026-11-04-su-root-switch.md` (MCP 의 root 실행은 2단계).
- 바꾸면 안 되는 것: 비밀번호는 출력 끝에 비밀번호 입력 문구(`Password:`/`암호:`/`비밀번호:`)가 보일 때만, 한 번만 보낸다. 10초 안에 문구가 없으면 보내지 않는다 (이미 root 이거나 su 가 묻지 않으면 비밀번호가 명령으로 실행·표시된다). 비밀번호를 보내기 전에는 `su:` 로 시작하는 줄만 실패로 본다 (로그인 안내문의 sorry 등을 실패로 오인하지 않게).
- 새 `src/*.js` 라서 `MAIN_RUNTIME_MODULES` 에 있다.

### Server File Window (SFTP 미리보기·편집)
SFTP 패널(본창·분리 창)의 서버 파일 우클릭 메뉴 `미리보기` / `편집` 으로 파일마다 창 하나(`?remoteFileMode=true&docId=...`, `RemoteFileWindow.tsx`)를 연다. main 은 `src/remoteFiles/` (`documents.js` 가 문서 상태, `ipc.js` 가 IPC, `remoteRead.js` 가 읽기, `backups.js` 가 백업). 같은 탭의 파일 창들은 그 탭 SSH 연결의 SFTP 채널 하나를 함께 쓰고(`documents.js` 의 `channels`, 마지막 창이 닫힐 때 닫음), SFTP 패널을 닫아도 쓸 수 있다. 창마다 채널을 열면 서버의 연결당 채널 수 제한(OpenSSH `MaxSessions`, 기본 10)에 걸려 분할 터미널이 열리지 않을 수 있다. 설계: `docs/plan/2026-11-05-sftp-file-edit-preview.md`.
- 편집기는 CodeMirror 6, Windows 단축키(Ctrl+F/H/G/S/Z/Y). Vim/Emacs 키는 사용자가 원하지 않았다. 편집기 코드는 파일 창에서만 불러온다 (`App.tsx` 의 `lazy`).
- 터미널 왼쪽 파일 탐색기(`FileExplorer.tsx`)도 SFTP 목록과 같은 우클릭 메뉴를 쓴다 (`FileListContextMenu`, `buildContextMenuItems`). 이름 바꾸기·새 폴더는 트리 안 입력칸, 다운로드는 저장 위치를 묻고, 바뀐 폴더만 다시 읽는다 (`lib/fileExplorerTree.ts`). 탐색기에는 F2·Delete 키가 없어 메뉴에 단축키를 표시하지 않는다. 메뉴는 `document.body` 에 그리고 실제 크기를 재서 놓는다 (`fitMenu`): 탐색기·SFTP 패널은 transform 이 걸린 상자 안이라 그 안에 그리면 잘린다.
- 편집: 5MB 이하 UTF-8 텍스트. CRLF 파일은 CRLF 로 저장하고, 섞인 줄바꿈은 LF 로 통일된다 (`lib/remoteFileText.ts`). 쓰기 권한은 열 때 `r+` 로 열어 보고 닫아서 판단한다.
- 미리보기: 이미지·PDF 는 50MB 까지 `blob:` URL (PDF 는 iframe 의 Chromium 뷰어, CSP 에 `img-src blob:` `frame-src blob:`), 그 밖은 텍스트로 5MB 까지 전체, 넘으면 마지막 1MB.
- 바꾸면 안 되는 것: 저장은 `review`(diff 와 토큰) → `save`(같은 내용의 SHA-256) 순서로만 된다. 저장 직전에 서버 내용을 PC 에 백업하고(`문서\ezShell Backups\<세션> (<계정>@<호스트>)\<서버 경로>\<이름>.<시각>.bak`, 파일마다 20개), 백업을 못 쓰면 저장하지 않는다. 쓰기는 MCP 와 같은 `remoteFile.writeIfUnchanged` (한 핸들로 비교 후 덮어쓰기, 소유자·권한 유지). 서버에 `.bak` 을 만들지 않는다 (`conf.d`, `cron.d` 처럼 폴더의 모든 파일을 읽는 곳에서 적용될 수 있음).
- 보안 검토 반영 (바꾸지 말 것): 오래된 백업 정리는 저장이 성공한 뒤에만 한다 (충돌로 거부될 때마다 정리하면 기록이 사라진다). 저장 중인 창을 닫으면 저장이 끝난 뒤 채널을 닫는다 (쓰는 도중 끊으면 서버 파일이 잘린다). 검토 토큰은 검토마다 새 난수이고 한 번만 쓴다. diff 가 잘리면 "나머지를 보지 않고 저장" 을 체크해야 저장된다. 백업 폴더 이름은 세션 이름을 40자로 자른 뒤 main 이 가진 `(계정@호스트)` 를 붙인다. 파일 창은 20개까지.
- 백업 목록에는 앱 백업(PC 아이콘)과 서버의 백업 파일(서버 아이콘, `compose.yaml.bak_20261020_1516` 처럼 같은 폴더에 사람이 남긴 것)이 시간순으로 섞인다 (`lib/backupCompare.ts`). 서버 파일 판정과 목록은 main 의 `serverBackups.js` (readdir 한 번, 일반 파일만, 50개, 이름의 날짜가 없으면 수정 시각). 바꾸면 안 되는 것: 창에는 이름만 보내고, 읽기(`remote-file-read-server-backup`)는 main 이 마지막으로 만든 목록에 있는 이름만 받는다. 읽은 실제 경로가 목록의 경로와 다르면(그 사이 링크로 바뀜) 거부한다. 설계: `docs/plan/2026-11-11-backup-compare-and-server-backups.md`.
- 백업 좌우 비교(`RemoteCompareView.tsx`, `@codemirror/merge` 의 MergeView): 왼쪽 백업(읽기 전용), 오른쪽 현재 내용, 가운데 » 로 그 부분만 백업 내용으로 바꾼다. 바꾸면 안 되는 것: 오른쪽은 편집기의 거울이다. 오른쪽의 모든 변경을 그대로 본 편집기(숨겨 두고 마운트 유지)에 보내므로, 저장·닫기 확인·Ctrl+Z 는 본 편집기 기준으로 동작한다. 편집기 내용을 통째로 바꾸는 동작(서버에서 다시 불러오기)은 비교를 먼저 닫는다.
- 같은 초에 백업이 여러 개면 번호를 가장 큰 번호 다음으로 붙인다. 정리로 비운 번호를 다시 쓰면 새 백업이 가장 오래된 것으로 정렬돼 바로 지워진다 (테스트로 잡은 버그).
- 요청마다 `docId` 와 보낸 창(webContents id)이 맞아야 답한다 (`documents.js` 의 `own`). 저장하지 않은 변경이 있으면 main 이 창 닫기를 막고 창에 묻는다 (`remote-file-close-requested` → `remote-file-close`).
- 새 `src/` 폴더라서 `MAIN_RUNTIME_DIRECTORIES` 에 `remoteFiles` 가 있다. MCP 모듈(`../mcp/remoteFile.js` 등)을 상대 경로로 쓴다.
- 실시간 보기(로그 따라가기): 우클릭 `실시간 보기`(모드 `tail`, 이미지·PDF 제외) 또는 텍스트 미리보기 창의 재생 버튼. main 의 `logTail.js` 가 한 번 볼 때마다 SFTP `stat` 하나만 보내고, 크기가 바뀌었을 때만 파일을 열어 늘어난 부분(최대 1MB, 넘으면 "N 건너뜀")을 읽고 바로 닫는다. 화면(`RemoteLogView.tsx`)은 답을 받은 뒤에만 다음 확인을 예약한다. 간격은 로그를 따른다 (`lib/logPollPace.ts`): 새 줄을 받으면 0.2초, 조용하면 0.4 → 0.8 → 1초로 늘리고, 가려지면 5초, 실패하면 3초. 조용한 로그의 서버 부담은 예전(1초마다 stat 하나)과 같다. 설계: `docs/plan/2026-11-05-log-live-view.md`.
  - 바꾸면 안 되는 것: 운영 서버 부담 때문에 서버에서 `tail -f` 같은 명령을 실행하지 않고, 파일을 열어 둔 채로 두지 않는다 (logrotate 가 지운 옛 파일의 디스크 공간이 풀리지 않는다). 확인 요청은 겹치지 않는다 (`documents.js` 의 `isTailing`, 진행 중이면 `busy`). 30초 안에 답이 없으면 포기한다.
  - 줄이 빠지지 않게: main 은 답마다 `cursor` 를 붙이고, 다음 요청이 그 cursor 를 가져와야 위치를 넘긴다 (아니면 마지막으로 받은 위치에서 다시 읽어 같은 줄을 보낸다). 일시정지·창 닫기로 화면이 버린 답 때문이다. `load` 마다 `generation` 이 바뀌고, 새로고침 전 화면의 요청은 `stale` 로 답한다. 로그 추가는 되돌리기 기록에 넣지 않는다 (`Transaction.addToHistory.of(false)`, 넣으면 지운 줄이 기록에 쌓여 메모리 상한이 깨진다).
  - 새 파일 판단: 크기가 줄었거나, 앞 256바이트가 달라졌거나, 링크가 다른 파일을 가리키거나, 없다가 다시 생기면 처음부터 읽는다 (logrotate `create`·`copytruncate`). 줄바꿈 전 조각은 main 이 최대 1MB 까지 붙잡는다. NUL 바이트는 지운다.
  - 강조는 `lib/logLevels.ts` 가 줄마다 첫 로그 수준 단어로 정한다 ("INFO ... ERROR" 는 오류 아님). 수준 단어가 없으면 예외 이름·스택 줄·Traceback 만 오류로 본다. 소문자 `error` 단어는 오류로 보지 않는다. 화면에 보이는 줄만 꾸미고(ViewPlugin), 개수는 붙인 줄과 지운 줄만 다시 센다 (`lib/logAppend.ts`). 창에는 최근 약 5MB 만 둔다.
  - 앱을 잠그면 미리보기·실시간 창은 닫고(`ipc.js` 의 `closeViewWindows`), 잠긴 동안 `remote-file-tail` 을 거부한다. 편집 창은 저장하지 않은 내용 때문에 닫지 않는다. 창이 뒤에 있을 때 새 오류가 오면 작업표시줄만 깜빡인다 (알림 센터에는 남기지 않음).

### DB Client (SSH 터널로 DB 조회)
상태바 왼쪽의 `DB` 표지(`DbIndicator.tsx`)가 활성 탭 서버의 DB 를 보여 주고, 고르면 계정 창(`DbConnectDialog.tsx`)을 거쳐 **본창의 DB 탭**을 연다 (`TerminalInfo.db`, id `db:<dbId>`, 내용은 `DbTab.tsx` → `DbClientView.tsx`). DB 탭의 `창으로 분리`(또는 탭을 창 밖으로 끌기)는 같은 접속을 DB 창(`?dbMode=true&dbId=...`, `DbClientWindow.tsx`)으로 옮긴다 (`db-detach`, 접속의 주인이 새 창으로 바뀐다). main 은 `src/dbClient/` (`discovery.js` 탐색, `connections.js` 창별 접속, `drivers/mysql.js`·`drivers/postgres.js`, `sqlGuard.js` 조회 문장 검사, `ipc.js`). 1단계는 조회만 된다 (MySQL/MariaDB, PostgreSQL). 설계: `docs/plan/2026-11-09-db-client.md`.
- 터널은 탭의 SSH 연결에서 `forwardOut` 으로 받은 스트림을 드라이버에 바로 넘긴다 (PC 에 포트를 열지 않음). pg 는 net.Socket 을 기대해서 `asSocket` 이 `connect`/`setNoDelay` 를 채운다.
- 탐색은 연결마다 한 번 실행 채널로 `ss`/`netstat` 과 `ps` 만 본다 (`createDiscoveryCache`, 연결 객체 기준). 바꾸면 안 되는 것: DB 포트에 접속해 확인하지 않는다 (MySQL 은 끝까지 가지 않은 접속을 세다가 `max_connect_errors` 를 넘으면 그 호스트를 막는다).
- 바꾸면 안 되는 것 (운영 DB 보호): 읽기 전용은 DB 서버가 강제한다. MySQL 은 접속마다 `SET SESSION TRANSACTION READ ONLY` 가 실패하면 접속을 쓰지 않고, PostgreSQL 은 시작 옵션 `default_transaction_read_only=on` 이 `on` 으로 확인돼야 쓴다. 그리고 두 엔진 모두 쿼리마다 `START TRANSACTION READ ONLY` / `BEGIN TRANSACTION READ ONLY` … `ROLLBACK` 으로 감싼다 (세션 설정은 SQL 로 바뀔 수 있다: PostgreSQL `SELECT set_config(...)`, `docs/brain/2026-11-09-postgres-read-only-session-bypass-with-set-config.md`). `sqlGuard.js` 는 두 번째 겹이다 (첫 단어 허용 목록, 문장 하나). PostgreSQL 쿼리는 pg-cursor(확장 프로토콜, 문장 하나)로만 보낸다. 트랜잭션을 열어 두지 않는다 (자동 커밋).
- 제한: 결과 1,000행·50MB (`results.js`), 쿼리 30초 (MySQL `MAX_EXECUTION_TIME`, MariaDB `max_statement_time`, PostgreSQL `statement_timeout`, 서버가 못 멈추면 앱이 취소 후 끊음), 창마다 접속 하나·요청 하나, DB 창 10개. MySQL 은 `sql_select_limit` 를 1,001 로 두고, 쿼리의 LIMIT 이 더 커서 2행 넘게 더 오면 접속을 끊고 다음 쿼리 때 다시 접속한다. 취소는 두 번째 짧은 접속으로 `KILL QUERY` / `pg_cancel_backend`.
- DB 창은 자기 webContents id 로만 답을 받는다 (`connections.js` 의 `own`). 계정은 main 창의 대화상자에서 main 으로만 가고 DB 창에는 가지 않는다. 앱을 잠그면 DB 창을 모두 닫고 접속을 끊는다 (`dbIpc.closeAll()`). 결과는 디스크에 쓰지 않는다.
- 계정 저장은 세션의 `dbConnections` (세션 파일과 함께 마스터 비밀번호로 암호화). "이 세션에 저장" 을 끄고 접속하면 그 저장 계정을 지운다.
- 다중 계정: 한 DB 서버에 계정을 여러 개 저장한다 (같은 계정은 id, 또는 서버·사용자·기본 DB 가 모두 같은 것). 계정마다 이름(`label`)을 붙이고, 상태바 목록은 서버별로 묶어 계정과 `다른 계정으로 접속…` 을 보여 준다 (`lib/dbChoices.ts` 의 `buildGroups`). DB 창은 계정마다 따로 연다. 계정 창의 `연결 테스트`(`db-test`)는 한 번 로그인해 읽기 전용까지 확인하고 바로 닫는다.
- DB 별칭: 상태바 목록의 서버 머리줄 연필로 DB 서버에 이름을 붙인다 (`DbAliasDialog.tsx`). 세션의 `dbAliases`(키는 `lib/dbChoices.ts` 의 `endpointKey`, 루프백 표기 무관)에 저장되어 세션 파일과 함께 암호화된다. 별칭이 있으면 머리줄에 별칭, 그 옆에 `엔진 · 주소` 를 보여 준다. 저장하지 않은 빠른 연결에는 연필이 없다.
- DB 트리(`DatabaseTree.tsx`)는 계정이 볼 수 있는 DB 를 모두 보여 준다 (PostgreSQL: DB → 스키마 → 테이블, MySQL: DB → 테이블). 보일 DB·스키마는 `TreeFilterMenu.tsx` 에서 고르고, 고른 것만 `localStorage` 의 `dbTreeFilter:<엔진>:<호스트>:<포트>:<사용자>` 에 남는다 (기본은 시스템 DB·스키마만 숨김, `lib/dbTreeFilter.ts`). 쿼리를 실행할 DB 는 도구 모음 선택 상자나 트리의 DB 두 번 누르기로 바꾼다 (`db-switch-database`, MySQL 은 `USE`, PostgreSQL 은 그 DB 로 다시 접속하고 읽기 전용을 다시 확인). 바꾸면 자동완성 기억을 비운다.
  - 바꾸면 안 되는 것: PostgreSQL 의 다른 DB 목록은 그 DB 에 짧게 접속해 읽고 바로 끊는다 (`rowsIn`). 접속을 붙잡아 두지 않는다. 창이 이름을 보내는 DB 는 서버가 준 목록에 있어야 한다 (`connections.js` 의 `knownDatabase`, PostgreSQL 은 그 이름으로 접속한다). PostgreSQL 기본 DB 를 비우면 `postgres` 로, 안 되면 사용자 이름 DB 로 접속한다 (관리자 계정은 사용자 이름 DB 가 없는 경우가 많다).
- 자동완성(`DbClient/dbCompletion.ts`, 계산은 `lib/sqlCompletion.ts`): 키워드는 `@codemirror/lang-sql` 의 MySQL/PostgreSQL 문법(요청 없음), 테이블은 기본 스키마 것만, 열은 문장의 FROM/JOIN 에 나온 테이블(최대 4개)이나 `별칭.` 뒤에서 그 테이블 하나만 읽고 창이 열린 동안 기억한다. 바꾸면 안 되는 것: 스키마 전체의 열을 한 번에 읽지 않는다 (MySQL 5.7 은 `information_schema.COLUMNS` 를 스키마 단위로 읽으면 모든 테이블 파일을 연다). 쿼리가 실행 중이면 새로 읽지 않는다. 창의 요청(쿼리, 트리, 자동완성)은 `lib/serialQueue.ts` 로 한 줄로 세운다 (main 은 겹친 요청을 "처리하는 중" 으로 거부한다). 편집기 파일 이름을 확장자 없는 `query` 로 두는 것은 편집기가 표준 SQL 을 따로 불러와 방언 설정과 겹치지 않게 하려는 것이다.
- DB 탭: 탭 줄·분할 패인에서 SSH 탭과 같이 다루되 SFTP·탭 복제·로그 저장은 없다 (`TabContextMenu` 의 `isTerminal`). 닫으면 `db-close` 로 DB 접속만 끊는다 (SSH 탭은 그대로). 일괄 명령(`BatchCommandModal`)과 상태바 연결 수에서는 뺀다. DB 탭이 앞에 있으면 상태바 `DB` 목록은 그 탭의 SSH 탭(`db.sshSessionId`) 기준이다.
  - 바꾸면 안 되는 것: 앱을 잠그면 렌더러가 DB 탭을 모두 지운다 (`App.tsx`, `isLocked` effect). main 은 접속을 닫으므로, 지우지 않으면 잠금 해제 뒤 죽은 탭이 남고 조회 결과가 잠금 화면 뒤 메모리에 남는다. `db-open`/`db-close`/`db-detach` 는 본창에서만 받는다.
  - 전역 단축키 처리기(`useKeyboardShortcuts`)는 `event.defaultPrevented` 인 키를 건너뛴다. DB 탭 안의 Ctrl+W(콘솔 닫기)가 탭 전체를 닫지 않게 하려는 것이다.
- 쿼리 콘솔(하위 탭, `DbConsole.tsx`, 계산은 `lib/dbConsoles.ts`): 콘솔마다 편집기·결과·실행 상태가 따로이고 접속은 하나를 함께 쓴다 (한 번에 하나만 실행, 다른 콘솔은 그동안 막힘). 최대 10개, Ctrl+T 새 콘솔, Ctrl+W 닫기, 두 번 눌러 이름 바꾸기. 콘솔의 SQL 은 계정별로 `localStorage` 의 `dbConsoles:<계정 키>` 에 남고(0.5초 뒤, 화면이 닫힐 때) 결과는 남기지 않는다.
- 기본 스키마(PostgreSQL): 도구 모음 선택 상자나 트리에서 스키마 두 번 누르기로 `search_path` 를 `"<스키마>", public` 으로 둔다 (`useSchema`, 쿼리마다의 읽기 전용 트랜잭션 밖에서 세션에 설정, 다시 접속하면 다시 설정). 계정·DB 별로 `dbDefaultSchema:<계정 키>:<DB>` 에 기억한다. 이름은 서버가 준 스키마 목록에 있어야 한다. DB 를 바꾸면 초기화.
- 새 `src/` 폴더라서 `MAIN_RUNTIME_DIRECTORIES` 에 `dbClient` 가 있다. 의존성 `mysql2`, `pg`, `pg-cursor` 는 정확한 버전으로 고정했다.

### SSH Algorithms (오래된 서버)
모든 ssh2 연결은 `src/sshAlgorithms.js` 의 `SSH_ALGORITHMS` 를 `algorithms` 로 넘긴다 (`main.js` 의 세 연결, `sshConnectionTest.js` 의 `buildOptions` → 연결 테스트·MCP). ssh2 기본값 뒤에 SHA-1 키 교환, CBC 암호, `ssh-dss`, `hmac-md5` 등을 `append` 로 붙여 PuTTY 로만 되던 오래된 서버에도 접속한다. 앞에 붙이거나 기본값을 바꾸지 말 것: 맨 뒤라서 새 방식을 아는 서버는 새 방식을 쓴다. 런타임이 지원하지 않는 이름은 빼고 붙인다 (ssh2 가 예외를 던짐). 새 `src/*.js` 라서 `MAIN_RUNTIME_MODULES` 에 있어야 한다. 설명: `docs/fix/2026-11-04-legacy-ssh-algorithms.md`.

### SSH Host Key Verification
모든 ssh2 연결(터미널, 점프 호스트, 자동 재연결, 연결 테스트, MCP)은 `hostVerifier` 로 서버의 호스트 키를 `userData/known-hosts.json` 과 비교한다 (`src/hostKeys/`). 설계와 보안 검토 반영: `docs/plan/2026-10-14-ssh-host-key-verification.md`.
- 처음 보는 서버나 바뀐 키는 연결을 바로 끊고 확인 창(`HostKeyDialog.tsx`)을 띄운 뒤, 신뢰하면 저장하고 처음부터 다시 접속한다. 핸드셰이크 중에 기다리면 readyTimeout 에 걸리기 때문이다.
- 묻는 곳은 터미널 연결과 연결 테스트뿐이다. 자동 재연결은 키가 다르면 재연결을 멈추고, MCP 는 저장된 키가 없거나 다르면 거부한다 (사람이 없을 수 있어서).
- MCP 로 가는 거부 문구에는 서버 주소를 넣지 않는다 (`hostKeyMessage(err, { subject })`, 게이트웨이는 "이 세션의 서버"/"이 세션의 점프 호스트"). 앱 화면 문구에만 주소가 들어간다.
- 바꾸면 안 되는 것: 렌더러는 요청 ID 와 결정만 보낸다 (`host-key-respond`). 저장하는 키는 main 이 거부할 때 붙잡아 둔 값이다. `createSessionGateway` 와 `testSshConnection` 은 저장소/검증 함수가 없으면 모든 키를 거부한다.
- 파일의 서버 주소는 HMAC 으로만 남긴다 (세션 파일은 암호화되어 있음). 파일을 읽지 못하면 저장하지 않는다 (덮어쓰면 저장된 키가 모두 사라져 "바뀜" 이 "처음 보는 서버" 로 보인다).
- `src/hostKeys` 는 번들되지 않고 `electron.vite.config.ts` 가 `out/main/src/hostKeys` 로 복사한다.

### Connection Lost Overlay (탭 연결 끊김)
탭의 연결이 끊기면(`TerminalInfo.connected: false`) 터미널 영역(분할 셸 포함)을 흐리게 하고 `ConnectionLostOverlay.tsx` 가 "연결 끊김" 과 `재연결` / `종료` 를 보여 준다. 문구는 `lib/connectionLost.ts`. 자동 재연결 중에는 시도 횟수(`TerminalInfo.reconnect`)를, 실패하면 이유(`disconnectNote`)를 보여 준다. 설계: `docs/plan/2026-10-27-terminal-connection-lost-overlay.md`.
- `재연결` 은 `ssh-reconnect-now` 로 탭을 처음 열 때와 같은 `openShellConnection` 을 같은 세션 ID 로 다시 부른다 (점프 호스트 포함, 바뀐 호스트 키는 확인 창). 자동 재연결(`reconnectOnce`)은 여전히 점프 호스트를 무시한다.
- 바꾸면 안 되는 것: 두 연결 함수의 `stream.on('close')` 는 그 셸이 아직 `sshConnections` 의 현재 셸일 때만 처리한다. 재연결로 바뀐 옛 셸의 늦은 close 가 새 연결을 끊김으로 표시하거나 자동 재연결을 또 시작하면 안 된다. 같은 이유로 자동 재연결은 상태가 `reconnecting` 일 때만 셸을 붙이고 다시 시도한다.
- 다시 연결되면 `TerminalPanel` 이 터미널 크기를 서버에 다시 보낸다 (새 셸은 80x24 로 열린다).
- 별도 창으로 분리한 터미널(`TerminalWindow.tsx`)도 같은 카드를 쓴다. 그 창은 터미널 스토어가 없어 연결 이벤트를 직접 듣고 같은 계산(`lib/connectionLost.ts` 의 `linkConnected`/`linkDisconnected`/`linkReconnecting`)으로 상태를 둔다. `종료` 는 연결을 끊고 창을 닫는다.

### LockScreen Safe API Pattern
`window.electronAPI` 함수 호출 전 `typeof` 체크로 graceful degradation.
앱 빌드 후 재시작 전 새 API가 없을 수 있음.

## Tech Stack
- Electron 28 + electron-vite 5
- React 19 + TypeScript 5.9
- xterm.js 5 (터미널 렌더링)
- ssh2 (SSH 프로토콜)
- Zustand 5 (상태 관리)
- Framer Motion 12 (애니메이션)
- Radix UI (다이얼로그, 드롭다운, 탭, 툴팁)
- Fuse.js (퍼지 검색)
- react-icons (아이콘)

## Conventions
- 한국어 UI (모든 사용자 대면 텍스트)
- CSS 변수 기반 테마 시스템 (`variables.css`)
- IPC 패턴: `ipcRenderer.invoke()` (양방향) / `ipcRenderer.send()` (단방향)
- 세션 데이터 암호화: 마스터 비밀번호 + AES, 자동 잠금 해제는 Electron safeStorage
