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

### Sidebar Session Tab Badge
사이드바 세션 옆에 그 세션에서 열린 탭 개수를 배지로 표시한다 (초록 테두리 = 연결됨, 빨강 테두리 = 끊김, 섞이면 둘 다).
탭 ID 는 메인 프로세스가 연결마다 만드는 값이라 사이드바 세션 ID 와 다르다. 둘은 `TerminalInfo.connectConfig.savedSessionId` 로만 이어진다 (`lib/sessionTabs.ts`).
배지의 탭이 1개면 바로 이동, 2개 이상이면 목록에서 고른다. 이동은 `terminalStore.focusTerminal` 을 쓴다 (분할 유지, 터미널에 키보드 포커스).
별도 창으로 분리한 탭과 저장하지 않은 빠른 연결은 세지 않는다.
축소 사이드바에서는 세션 행이 Tooltip Trigger 라서 배지/목록의 이벤트가 포털을 통과해 행까지 올라간다. 처리 내용은 `docs/brain/2026-10-01-react-events-bubble-through-portals-into-tooltip-trigger.md` 참고.

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
`src/mcp/` 에 로컬 MCP 서버가 있다. 설정 > MCP 에서 켜면 `127.0.0.1:<포트>/mcp` (Streamable HTTP, stateless) 로 열린다.
- 도구: `list_sessions`, `cd`, `run_command`, `write_file`, `edit_file`, `job_output`, `stop_job`, `list_jobs`. 세션 편집 > 고급 설정의 "MCP 접근 허용"(`mcpEnabled`)을 켠 세션만 보인다.
- 파일 쓰기(`write_file`, `edit_file`, `fileTools.js`)는 셸을 거치지 않고 SFTP 로 한다. 알림 수준과 무관하게 항상 확인 창을 띄우고, 창에는 명령 대신 변경 내용(diff)과 실제 경로(심볼릭 링크를 푼 경로)를 보여 준다. 제한 시간은 180초. 허용한 뒤 파일이 확인 창에 보여 준 내용과 달라졌으면 쓰지 않는다(`remoteFile.js` 의 `writeIfUnchanged`). 기존 파일은 같은 파일에 덮어써서 소유자·권한을 유지하고, 실패하면 이전 내용으로 되돌린다. 256KB·10,000줄 이하 UTF-8 텍스트만, 접속 계정 권한으로만 쓴다. 감사 로그에는 도구 이름, 경로, 승인 여부, 내용의 SHA-256 만 남고 내용은 남지 않는다. 설계와 보안 검토 반영: `docs/plan/2026-10-02-mcp-file-tools-design.md`.
  - 바꾸면 안 되는 것: 덮어쓰기는 파일을 `r+` 로 한 번 열어 그 핸들의 내용을 비교하고 같은 핸들에 쓴다 (경로를 다시 여는 방식으로 바꾸면 그 사이에 링크로 바뀐 경로를 따라간다). 읽기는 핸들에서 256KB+1 까지만 한다 (`readFile` 은 크기 0 으로 보이는 파일을 끝없이 읽는다). `/proc`, `/sys`, `/dev` 는 거부한다.
  - diff 계산(`fileEdit.js`)은 300ms 제한이 있고, 넘으면 전체 교체로 표시한다. 제한을 없애면 줄이 많은 입력에 main 프로세스가 멈춘다.
  - `cat` 으로 읽을 때 확인이 필요한 알림 수준·경로에서는 `edit_file` 을 거부한다 ("찾지 못함" 같은 답으로 내용을 추정할 수 있어서).
  - 확인 창의 "허용"은 창이 뜬 뒤 0.8초, 그리고 변경 내용을 끝까지 내려 보기 전에는 눌리지 않는다.
- 백그라운드 작업(`run_command` 의 `background: true`, `job_output`, `stop_job`, `list_jobs`)은 30초를 넘는 명령을 위한 것이다. main 이 실행 채널을 요청과 분리해 붙잡고(`jobChannel.js`), 출력은 메모리에만 둔다(`jobStore.js`, 작업당 마지막 1MB). 판정은 `run_command` 와 같은 경로(`tools.js` 의 `guarded`)를 지나고, 알림 수준과 무관하게 항상 확인 창을 띄워 "백그라운드 실행 · 최대 N분" 을 보여 준다 (낮음 명령도 한 시간 동안 돌 수 있어서). 기본 10분·최대 60분, 세션당 3개·전체 6개, 총 출력이 16MB 를 넘으면 중지한다. 앱을 잠그거나 MCP 를 끄면 모든 작업을 중지하고 목록을 지운다 (앱을 닫아도 이어지는 작업은 일부러 만들지 않았다). 설계: `docs/plan/2026-10-02-mcp-background-jobs-design.md`.
  - 바꾸면 안 되는 것: 작업 스크립트의 첫 줄이 셸 PID 를 stderr 로 알리고, 중지할 때 시그널 요청에 더해 `kill -KILL -- -<PID>` 를 보낸다. OpenSSH 7.9 미만은 시그널 요청을 무시하고, 채널만 닫으면 프로세스가 서버에 남는다 (실제 sshd 로 확인함). PID 가 1 이하면 버린다 (`kill -- -1` 은 계정의 모든 프로세스를 죽인다).
  - 작업이 끝났다는 보고(`done`)는 kill 명령이 끝난 뒤에 한다. 잠글 때는 작업이 끝나는 대로 연결을 닫으므로, 먼저 보고하면 kill 이 서버에 도착하기 전에 연결이 닫힌다. 같은 이유로 PID 줄을 받기 전에는 채널을 닫지 않고(최대 1초 기다림), 작업은 채널을 요청하는 순간부터 그 연결의 작업으로 세며, 앱 종료는 작업이 있으면 `shutdown()` 이 끝날 때까지 기다린다 (`main.js` 의 `before-quit`).
  - 출력은 50ms 마다 묶어서 넘긴다 (`jobChannel.js` 의 `createBatcher`). 묶지 않으면 한두 바이트씩 내는 명령이 이벤트마다 보관 버퍼를 복사하게 해서 main 프로세스가 멈춘다. 활동 출력의 조각 수 제한(2,000개)도 같은 이유다.
  - 시작된 작업은 그 작업을 시작한 요청의 신호로 멈추지 않는다 (요청이 끝난 뒤에도 실행되어야 한다). 멈추는 것은 활동 패널의 "중지", `stop_job`, 제한값, 잠금뿐이다.
  - 세션을 저장하면 연결을 바로 닫지 않고 떼어 낸다(`retireAll`). 새 요청은 새 설정으로 다시 접속하고, 작업이 있는 옛 연결은 작업이 끝나면 닫힌다. 허용이 꺼진 세션의 작업은 중지한다.
  - `job_output` 은 작업이 끝나기를 `wait_seconds` 만큼 기다린 뒤 그동안의 출력을 모아서 준다. 출력이 나올 때마다 돌려주면 Claude 가 줄마다 호출한다 (43초 작업에 41번 호출됐었다).
  - 활동 목록은 100개를 넘으면 끝난 요청부터 버린다. 실행 중인 요청을 버리면 그 요청의 "중지" 버튼이 사라진다. 요청당 출력은 마지막 512KB 만 둔다 (main 과 렌더러가 같은 값).
- 호스트 주소와 계정은 Claude 에게 넘기지 않는다. 대신 `list_sessions` 가 `server` 표지(`서버-1`, ...)를 붙여 같은 서버에 접속하는 세션을 알려 준다 (호스트+포트, 점프 호스트를 쓰면 그 주소까지 같아야 같은 서버). 표지는 목록 순서 번호이고 주소의 해시가 아니다 (IP 해시는 역산할 수 있음).
- 명령은 `commandPolicy.js` 가 낮음/중간/위험/절대 차단으로 판정한다. 처음 보는 명령은 위험. 위험은 항상 앱 확인 창(60초 안에 응답 없으면 거부), 절대 차단은 실행 불가.
- 설정은 `userData/mcp.json`(main 전용), 감사 로그는 `userData/mcp-audit.log`(명령과 판정만, 출력은 기록하지 않음).
- 상태바의 "MCP 활동" 패널이 요청과 상태(대기/실행/완료/거부/취소/차단)를 실시간으로 보여준다. 이 목록과 명령 출력은 메모리에만 있고 디스크에 쓰지 않는다 (출력에 비밀이 섞일 수 있음).
- 패널에는 `목록 | 터미널` 두 보기가 있다 (기본은 터미널). 터미널 보기(`McpActivityTerminal.tsx`)는 명령과 출력을 시간순으로 잇는 읽기 전용 화면이고 xterm 이 아니다. 실행 중 출력은 `sessionGateway` 의 `onOutput` → `activityLog.appendOutput`(50ms 묶음) → `mcp-activity-output` 채널로 온다. 요청이 끝날 때 오는 `mcp-activity` 항목이 `outputParts` 전체를 담고 있어 그쪽이 기준이다. 탭으로 만들지 않은 이유: 탭은 모두 SSH 연결 하나를 전제로 한다.
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
