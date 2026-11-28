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
npm run build:portable  # 포터블 exe (배포 때는 GitHub Actions 가 만든다)
npm run build:publish   # GitHub Releases 배포 (설치형·latest.yml 만, electron-updater)
```

### 목업

화면 목업(`mockups/*.html`)은 실제 앱에서 뜬 시작 틀(`npm run build` 뒤 `npm run mockup:kit` → `mockups/_kit/app.html`, `ezshell.css`)을 복사해 바꾸려는 영역만 고친다. 바꾸면 안 되는 것: 색·서체·모서리를 새로 짓지 않고 앱의 클래스와 CSS 변수만 쓴다 (2026-11-28 사용자 요청: 디자인을 새로 지어낸 목업은 무엇을 바꾸자는지 읽기 어렵다). [목업 만들기](docs/mockups.md)

### 화면 테스트

`npm run build` 뒤 `npm run e2e` (전부) 또는 `npm run e2e -- shortcuts` (하나). `e2e/run.js`는 명세마다 임시 프로필로 빌드된 앱을 띄우고 CDP로 조작한 뒤 끝낸다. 화면 캡처는 `e2e/.out/`에 둔다. `ssh-` 명세에서는 실행기가 `e2e/support/sshd.js`로 시험용 서버를 띄운다. 새 명세는 `e2e/support/driver.js`를 쓰고 콘솔 오류와 CSP 거부는 `pageProblems`로 확인한다. [명세와 도우미](docs/architecture/screen-tests.md)

- 앱은 `npx` 를 거치지 않고 Electron 실행 파일로 직접 띄운다 (`npx` 를 끝내면 Electron 이 남아 디버깅 포트를 잡고, 다음 명세가 옛 앱에 붙는다).
- 명세를 쓸 때: 앞에 있지 않은 탭은 `display: none` 이 아니라 `visibility: hidden` 으로 숨는다 (탭 내용이 배치를 유지한다). 보이는 탭을 고를 때 `offsetParent` 만 보면 숨은 탭도 잡힌다.
- 바꾸면 안 되는 것: 같은 이유로 탭 내용 안에서 숨김을 풀 때 `visibility: visible` 을 쓰지 않고 `inherit` 를 쓴다. 자식의 `visible` 은 숨은 탭을 뚫고 앞 탭 위에 그려진다 (`docs/fix/2026-11-25-chat-time-shows-through-hidden-tab.md`).
- 화면 시험은 기본으로 `EZSHELL_TEST_HIDDEN_WINDOWS=1`을 켜 모든 창을 모니터 밖에 표시한다. CDP가 페이지 내부 포커스와 입력을 처리한다. 실제 창이 필요한 `local-work-overview`, `window-place`는 기본 실행에서 이유를 알리고 건너뛴다. 사용자가 실제 창을 봐도 되는 경우에 `npm run e2e -- --visible <명세>`로 실행한다.
- 패키징된 앱은 숨김 모드를 읽지 않는다. 실제 창을 띄우기로 한 경우 `E2E_APP=<release/.../win-unpacked/ezShell.exe 의 전체 경로> npm run e2e -- --visible`로 실행한다.
- 화면 테스트에서 창 크기를 잴 때: 페이지의 `outerWidth`·`screenX` 는 프레임 없는 창의 보이지 않는 크기 조절 테두리(좌우·아래 8px)를 포함하고, main 의 `getBounds`(앱이 저장하는 값)는 포함하지 않는다. 페이지의 `window.moveTo`·`resizeTo` 도 준 숫자에 정확히 놓지 않는다 (`e2e/specs/window-place.js` 의 `isAt`).

**테스트 범위** (2026-11-24 사용자 결정, 에이전트 공통. 전역 테스트 규칙보다 이 절이 우선한다): 여러 에이전트가 같은 작업 폴더의 main 에서 동시에 일하고, 커밋하지 않은 다른 세션의 변경이 늘 섞여 있다. 전체를 돌리면 남이 만들고 있는 코드까지 시험하고 그 실패를 쫓게 된다. 그래서 테스트는 내가 바꾼 것만 본다.
- 작업 중: 그 테스트 파일만 `npx vitest run <파일>`.
- 끝날 때: `npx vitest related <내가 바꾼 파일들> --run`(그 파일을 직접·간접으로 쓰는 테스트만 고른다. 여러 기능이 함께 쓰는 모듈을 바꾸면 그 모듈을 쓰는 테스트도 저절로 들어간다), `npm run typecheck`, `npm run build`. 화면 테스트는 바꾼 기능을 다루는 명세만 `npm run e2e -- <명세>`.
- 전체 단위 테스트(`npm test`)와 전체 화면 테스트(`npm run e2e`)는 사용자가 요청할 때, 또는 테스트 도구 자체(vitest 설정, 모든 명세가 쓰는 `e2e/support/driver.js`·`e2e/run.js`)를 바꿨을 때만. 배포 요청 때는 테스트를 돌리지 않는다.
- 내가 바꾸지 않은 곳의 실패는 원인을 짚어 알리기만 하고 고치지 않는다 (사용자가 요청할 때만). 내 변경이 원인인지 볼 때 다른 세션의 변경을 건드리는 명령(`git stash`, `git checkout -- .`, `git reset --hard`)은 쓰지 않는다.

### Electron과 패키징

Electron 은 45.3.3 이다 (`docs/plan/2026-11-17-electron-upgrade-notes.md`).
- `npm install`/`npm ci` 뒤에 `npx install-electron --no` 를 한 번 실행한다. Electron 42 부터 npm 패키지가 설치 때 실행 파일을 받지 않는데, `electron-vite` 5 는 그 파일이 없으면 `npm run dev` 가 실패한다. mac 빌드 워크플로에도 같은 단계가 있다.
- 다음에 올릴 때 걸리는 것: 46 에서 `safeStorage` 의 동기 메서드(`encryptString` 등)가 없어진다. 자동 잠금 해제(`main.js`)와 원격 접속의 봉인(`sealer`)이 쓰고 있어, 46 으로 가기 전에 비동기 메서드로 바꿔야 한다 (45 에서는 경고만 나온다).
- macOS 는 13(Ventura) 이상에서만 실행된다 (Electron 44 부터, `build.mac.minimumSystemVersion`).

배포 결과물: `release/` 폴더 (electron-builder). `dist/`는 예전 빌드 산출물이다.

설치본 크기: `build.electronLanguages` 로 Chromium 언어 팩을 `ko`·`en-US` 만 넣고(목록에 없는 언어는 en-US 로 떨어진다. 둘은 지우지 말 것), `build.files` 에서 화면 코드에 이미 묶여 들어가는 편집기 패키지(`@codemirror`, `@lezer`, `@marijn`, `crelt`, `style-mod`, `w3c-keyname`, `xterm-addon-serialize`), `node_modules` 의 `.map`, `zod`·`@js-joda/core` 의 TypeScript 원본(`src`)을 뺀다. 바꾸면 안 되는 것: main(`main.js`, `src/`)에서 `require` 하는 패키지는 빼지 말 것 (빼도 빌드는 되고, 그 기능을 처음 쓸 때 앱이 오류를 낸다). 화면 전용 패키지를 새로 넣으면 이 목록에 더한다. 플랫폼별 `win.files` 로 다른 OS 용 네이티브 파일(`node-pty` prebuilds, `oracledb` 바이너리)을 빼 보았으나, 결과 `app.asar` 가 파일 목록은 같은데 10MB 커지는 현상이 있어 두지 않았다. 바꾼 뒤에는 `E2E_APP=<release/.../win-unpacked/ezShell.exe>` 로 화면 테스트를 돌리고, `ELECTRON_RUN_AS_NODE=1 ezShell.exe -e` 로 main 모듈이 묶음에서 불러와지는지 본다.

### 배포와 릴리스 노트

**릴리스 노트:** 버전을 올리기 전에 `release-notes/<버전>.md` 를 쓴다 (사용자에게 보이는 한국어, `##`/`###` 제목·`-` 목록·`코드`·**굵게** 만 그려진다). 없으면 `releaseNotes.test.ts` 가 실패한다. GitHub 릴리스 본문도 이 파일로 만든다 (`gh release create v<버전> --notes-file release-notes/<버전>.md`). 바꾸면 안 되는 순서: 릴리스를 `gh release create` 로 먼저 만든 뒤 `npm run build:publish` 를 돌린다 (토큰은 `GH_TOKEN=$(gh auth token)`). 릴리스가 없으면 electron-builder 가 같은 태그의 릴리스를 따로 만들 수 있다. 그 경우 파일이 든 쪽을 남기고, 빠진 `ezShell-Setup-<버전>.exe.blockmap` 을 옮긴 뒤 다른 쪽을 지운다 (`gh release upload` 의 `#이름` 은 공백을 점으로 바꾸므로 파일 이름을 맞춰 올린다). `build:publish` 는 설치형(NSIS)·blockmap·`latest.yml` 만 만들어 올린다. 포터블 exe 는 릴리스가 공개되면 GitHub Actions 의 `.github/workflows/windows-portable.yml`(windows-latest 러너)이 만들어 붙인다. 자동 업데이트는 설치형만 쓰므로 포터블이 몇 분 늦게 붙어도 된다. 그 빌드가 실패하면 Actions 탭에서 그 워크플로를 태그(`v<버전>`)를 넣어 다시 돌린다. 배포 뒤 확인할 파일은 Windows 4개(Setup exe·blockmap·`latest.yml`·포터블)와 macOS 4개(arm64와 x64 각각 DMG·ZIP)다.

업데이트 확인, 릴리스 노트 창, 앱 재시작과 탭 복원은 [앱 업데이트와 탭 복원](docs/architecture/app-updates.md)을 읽는다.

## Architecture

### Process Model

- **Main Process** (`main.js` + `src/ipc/`): SSH 연결(ssh2), SFTP, IPC 핸들러, 마스터 비밀번호/암호화, safeStorage
  - `main.js`에는 앱 시작·본창·잠금과 세션 저장·MCP 와 원격 접속 연결이 있고, 그 밖의 IPC 묶음은 `src/ipc/` 에 있다: `sshSessions.js`(탭의 SSH 연결·재연결·세션 로그 IPC), `splitShells.js`(분할 셸·탭으로 빼기), `sftp.js`(SFTP·이 PC 의 파일·전송 대기열), `portForward.js`, `commandHistory.js`, `pathBookmarks.js`, `updates.js`, `detachedWindows.js`(분리 창 다섯 종류). 기능별 문서에서 `main.js` 의 함수로 설명하는 항목(`openShellConnection`, `reconnectOnce`, `ssh-adopt-split`, `endedByItself` 등)은 이제 이 파일들에 있다. 묶음마다 `register…(ctx)` 함수 하나이고, `main.js` 가 함께 쓰는 것(연결 목록, 창)을 `ctx` 로 넘긴다.
  - 바뀌는 값(`mainWindow`, `isAppLocked`, `currentMasterPassword`)은 `ctx` 의 getter 로 넘긴다 (`ctx.mainWindow`): 값을 그대로 넘기면 넘긴 순간의 값(`undefined`)에 머문다.
  - 바꾸면 안 되는 것: `ctx` 에 넘기는 이름이 `main.js` 에서 그 호출보다 아래에 `const` 로 선언돼 있으면 앱이 시작할 때 죽는다 (선언 전 접근). 그런 것은 `fromMainWindow: (event) => fromMainWindow(event)` 처럼 호출로 감싸 넘긴다. 묶음을 옮기거나 더한 뒤에는 화면 테스트로 앱이 뜨는지 본다 (단위 테스트는 `main.js` 를 실행하지 않아 잡지 못한다).
  - `src/ipc/` 의 파일에서 `__dirname` 은 `main.js` 의 폴더가 아니다. preload·페이지 경로가 필요한 묶음은 `main.js` 의 `__dirname` 을 받아 쓴다 (`detachedWindows.js`).
- **Preload** (`src/preload.js`): contextBridge로 `window.electronAPI` 노출
- **Renderer** (`src/renderer/`): React 앱, Vite 빌드

### main 런타임 파일

바꾸면 안 되는 것. `main.js`가 런타임에 `require('./src/...')` 하는 새 파일은 `electron.vite.config.ts`의 `MAIN_RUNTIME_MODULES`에, 하위 디렉터리는 `MAIN_RUNTIME_DIRECTORIES`에 등록한다. 이 파일은 번들에 포함되지 않으므로 복사 목록이 빠지면 배포본에서 모듈을 찾지 못한다. 대상은 `out/main/src`이며 디렉터리의 테스트와 테스트 도우미는 복사하지 않는다.

### Key Directories

```
main.js                          # Electron 메인 프로세스 (시작, 본창, 잠금, 세션 저장)
src/ipc/                         # main.js 에서 나눈 IPC 묶음 (SFTP, 포트 포워딩, 업데이트, 분리 창 등)
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
    globals.css                  # 전역 스타일의 목록만 (부품을 불러오는 순서: 같은 우선순위의 규칙은 순서로 정해지므로 바꾸지 말 것)
    app/*.css                    # 전역 스타일 부품 (기능별, 예전 globals.css 를 순서대로 나눈 것)
    tailwind.css                 # @tailwind 지시문
    variables.css                # CSS 변수 (색상, 테마)
```

## 공통 보안 규칙

- 본창 전용 기능의 IPC는 본창의 주 프레임과 잠금 해제 상태를 main에서 확인한 뒤 처리한다. 잠금 화면에 필요한 API와 분리 창 전용 IPC는 각 기능의 허용 범위를 따른다. IPC 입력을 사용할 때 main에서 ID, 세션, 허용된 데이터와 경로를 다시 검사한다. [채팅 IPC](docs/architecture/agent-chat.md) · [작업 공간 IPC](docs/architecture/workspace-files-git.md) · [원격 접속 IPC](docs/architecture/remote-access.md)
- MCP와 휴대폰에서 로컬 셸에 직접 입력하는 경로를 열지 않는다. 에이전트 입력은 각 기능의 검증된 채팅 또는 받은편지함 경로로만 처리한다. 작업 공간의 에이전트 기록·검색·파일·세션 재개는 main의 본창 전용 경로를 이용한다. [MCP와 에이전트 메시지](docs/architecture/mcp-and-agent-messages.md) · [휴대폰 채팅](docs/architecture/remote-access.md) · [에이전트 기록](docs/architecture/agent-history.md)
- 외부에서 받은 경로를 열거나 파일 내용을 읽기 전에 로컬 경로 검사(`src/localKeyPath.js`의 `isLocalFilePath`)와 기능별 허용 루트·실제 경로 검사를 적용한다. SSH 개인 키는 `readPrivateKeyFile`로 읽는다. UNC 조회가 Windows의 자격 증명을 보낼 수 있고, 장치 경로 읽기가 끝나지 않을 수 있다. [세션 가져오기](docs/architecture/session-import.md) · [작업 공간과 저장소](docs/architecture/workspace-files-git.md)

- 세션 데이터 암호화: 마스터 비밀번호 + AES, 자동 잠금 해제는 Electron safeStorage. 세션의 비밀 필드는 `src/sessionSecrets.js` 의 `SECRET_FIELDS`(비밀번호·암호 구문·키 경로, root 전환 비밀번호, 점프 호스트의 셋, `dbConnections`)가 모두 하나의 암호화 묶음에 들어간다. 바꾸면 안 되는 것: 세션에 비밀 값을 담는 필드를 새로 만들면 이 목록에 더한다 (목록에 빠진 비밀 필드가 평문으로 저장되는 것을 막는다. `docs/fix/2026-11-18-session-secrets-in-plain-text.md`). 옛 형식 파일은 세션을 읽기 직전에 다시 암호화해 쓴다 (`main.js` 의 `resealSessionsFile`). `sessions.json` 은 `writeSessionsFile`(임시 파일 후 이름 바꾸기)로만 쓴다.

## 기능별 문서

이 목록의 파일을 고치기 전에 그 기능 문서를 먼저 읽는다. 파일 이름의 경로는 저장소나 해당 구성 요소의 폴더를 기준으로 한다.

- 화면 테스트 명세 — 빌드된 앱·임시 프로필·시험 서버와 CDP 도우미 · `e2e/run.js`, `e2e/support/driver.js`, `e2e/support/sshd.js` · [docs/architecture/screen-tests.md](docs/architecture/screen-tests.md)
- 앱 업데이트와 탭 복원 — 릴리스 노트 표시, 안전한 설치와 탭 복원 · `src/updateChecker.js`, `src/restoreTabs.js`, `lib/updateInstall.ts`, `lib/restoreTabsRun.ts` · [docs/architecture/app-updates.md](docs/architecture/app-updates.md)
- SSH Data Flow — 셸 출력과 분할 채널의 IPC 흐름 · `main.js`, `src/ipc/sshSessions.js`, `terminalStore.ts` · [docs/architecture/ssh-connections.md](docs/architecture/ssh-connections.md)
- State Management (Zustand) — 터미널 수명과 SSH 데이터 버퍼 · `terminalStore.ts`, `App.tsx` · [docs/architecture/renderer-state.md](docs/architecture/renderer-state.md)
- Two Split Systems — 화면 나누기와 셸 칸 나누기의 상태 및 놓기 규칙 · `lib/splitTree.ts`, `lib/screenPanes.ts`, `useTabDropOnPane.ts` · [docs/architecture/split-layout.md](docs/architecture/split-layout.md)
- Detached Window Zoom (분리 창의 UI 배율) — 분리 창 유형별 UI 배율과 키 동작 · `Zoom/WindowZoom.tsx`, `lib/windowZoom.ts`, `lib/appZoom.ts` · [docs/architecture/detached-windows.md](docs/architecture/detached-windows.md)
- Detached Window Places (분리 창의 위치 기억) — 분리 창 유형별 위치·크기·최대화 복원 · `src/detachedPlaces.js`, `src/ipc/detachedWindows.js`, `src/windowState.js` · [docs/architecture/detached-windows.md](docs/architecture/detached-windows.md)
- Tab Groups (작업별 탭 묶음) — 작업별 탭 묶음과 넘나들기 · `lib/tabGroups.ts`, `hooks/useTabGroups.ts`, `Terminal/TabGroupChips.tsx` · [docs/architecture/tab-groups.md](docs/architecture/tab-groups.md)
- Tab Content Hosts (배치가 바뀌어도 탭을 다시 만들지 않는다) — 배치 이동 중 탭 DOM과 셸 수명 유지 · `App.tsx`, `lib/tabHosts.ts`, `Terminal/TabSlot.tsx` · [docs/architecture/tab-groups.md](docs/architecture/tab-groups.md)
- SSH Channel Open Failure — 분할 채널 열기 실패 시 정리와 재시도 · `src/ipc/splitShells.js`, `SplitTerminal.tsx` · [docs/architecture/ssh-connections.md](docs/architecture/ssh-connections.md)
- Split Panes (칸 나누기·자리 바꾸기·탭으로 빼기) — 칸 크기·옮기기·닫기와 탭 사이 셸 이전 · `lib/paneToTab.ts`, `lib/tabToPane.ts`, `Terminal/SplitChrome.tsx`, `src/ipc/splitShells.js` · [docs/architecture/split-layout.md](docs/architecture/split-layout.md)
- Terminal Right-Click Menu — 터미널 검색·전송·파일 탐색 메뉴 · `Terminal/useTerminalContextMenu.tsx`, `TerminalContextMenu.tsx`, `lib/terminalTarget.ts` · [docs/architecture/terminal-menu.md](docs/architecture/terminal-menu.md)
- Terminal Log Highlight (오류·경고 줄 강조) — 터미널 오류·경고 줄 판독과 강조 · `Terminal/terminalLogHighlight.ts`, `lib/terminalLogRows.ts`, `lib/logLevels.ts` · [docs/architecture/terminal-logs.md](docs/architecture/terminal-logs.md)
- Local Terminal Tab (이 PC 의 셸) — 로컬 PTY 수명·배치 복원·에이전트 입력 · `src/localShell.js`, `Terminal/LocalTerminalTab.tsx`, `lib/localReloadLayout.ts` · [docs/architecture/local-terminal.md](docs/architecture/local-terminal.md)
- Local Project Run Presets (로컬 프로젝트 실행 구성) — 구성 저장·기동·Tomcat과 Maven·바로 반영·실행 진단·에이전트 조작 · `src/ipc/runPresets.js`, `src/ipc/runPresetStore.js`, `src/ipc/hotReload.js`, `src/runtimes/` · [docs/architecture/local-project-run.md](docs/architecture/local-project-run.md)
- Work Panel and Agent Session History (작업 공간의 대화 기록) — 작업 공간의 대화 목록, 세션 확인과 재개 · `Workspace/WorkspacePanel.tsx`, `src/agentHistory/ipc.js`, `lib/agentHistory.ts` · [docs/architecture/agent-history.md](docs/architecture/agent-history.md)
- Sidebar Tree and Folded Rail — 세션 트리, 검색과 접힌 레일 · `Sidebar/SidebarTree.css`, `lib/sidebarRail.ts`, `hooks/useSidebarPeek.ts`, `lib/sessionSearch.ts` · [docs/architecture/sidebar.md](docs/architecture/sidebar.md)
- Session Share Text (연결 정보 복사·텍스트로 세션 추가) — 연결 정보 복사와 암호화된 텍스트 가져오기 · `Sidebar/SessionImportDialog.tsx`, `lib/sessionShare.ts`, `lib/shareCrypto.ts` · [docs/architecture/session-import.md](docs/architecture/session-import.md)
- Session Import From Other Programs (다른 프로그램에서 가져오기) — 외부 SSH 클라이언트의 저장 연결 읽기 · `Settings/ExternalImportDialog.tsx`, `lib/externalImport.ts`, `src/sessionImport/ipc.js`, `src/localKeyPath.js` · [docs/architecture/session-import.md](docs/architecture/session-import.md)
- Workspace Files and Git Details (작업 공간의 파일 열기·편집과 Git 변경 내용) — 로컬 파일 읽기·편집과 Git 조회·선택 커밋 · `Workspace/WorkspaceDetails.tsx`, `Workspace/WorkspaceGitChanges.tsx`, `src/localFiles/roots.js`, `src/localFiles/gitCommit.js` · [docs/architecture/workspace-files-git.md](docs/architecture/workspace-files-git.md)
- Agent Chat View (에이전트 칸을 채팅으로 보기) — Claude·Codex 채팅, PTY 입력·확인 및 대화 표시 · `AgentChat/AgentChatCover.tsx`, `stores/agentChatStore.ts`, `src/agentChat/ipc.js`, `src/ipc/agentInboxWake.js` · [docs/architecture/agent-chat.md](docs/architecture/agent-chat.md)
- Antigravity Chat View (Antigravity 채팅 보기) — Antigravity 실행·상태 보고·대화 기록 연결 · `src/localShell.js`, `src/ipc/antigravityStatusReport.js`, `src/agentChat/antigravitySessions.js`, `src/ipc/antigravityInboxScreen.js` · [docs/architecture/antigravity-chat.md](docs/architecture/antigravity-chat.md)
- Browser Tab Links and Menu (브라우저 탭의 새 창 링크·우클릭 메뉴) — 브라우저 탭의 새 창 링크와 우클릭 메뉴 · `src/ipc/browserReview.js`, `src/ipc/browserContextMenu.js` · [docs/architecture/browser-tab.md](docs/architecture/browser-tab.md)
- Idle Agents (쉬는 에이전트의 메모리 비우기·잠재우기) — 유휴 에이전트 잠재우기와 깨우기 · `src/agentIdle.js`, `src/localShell.js`, `lib/agentIdlePrefs.ts`, `AgentChat/AgentSleepCover.tsx` · [docs/architecture/idle-agents.md](docs/architecture/idle-agents.md)
- Agent History Content Search (에이전트 기록의 대화 내용 검색) — 대화 본문 검색, 결과 발췌와 읽기 제한 · `AgentHistoryPanel.tsx`, `lib/agentHistory.ts`, `src/agentHistory/search.js` · [docs/architecture/agent-history.md](docs/architecture/agent-history.md)
- Agent Session Drag (에이전트 기록의 대화를 끌어 놓아 이어서 열기) — 작업 공간 기록에서 끌어서 대화 재개 · `lib/agentSessionDrop.ts`, `hooks/useAgentSessionDrop.ts`, `App.tsx` · [docs/architecture/agent-history.md](docs/architecture/agent-history.md)
- Sidebar Local Work Tree (로컬 작업: 저장소 → 워크트리 → 탭) — 저장소·워크트리·탭 구성과 표시 · `Sidebar/LocalProjectsTree.tsx`, `hooks/useLocalProjects.ts`, `lib/localWorkspaceTree.ts` · [docs/architecture/sidebar.md](docs/architecture/sidebar.md)
- Nested Git Repositories (로컬 작업의 하위 Git 저장소) — 브랜치·변경 요약, 포커스에서 가져오기와 빠른 감기 방식의 받기 · `src/ipc/nestedRepositories.js`, `Sidebar/NestedRepositories.tsx` · [docs/architecture/sidebar.md](docs/architecture/sidebar.md)
- Sidebar Local Terminal List (세션 목록 아래의 로컬 터미널 목록) — 로컬 터미널·연결 서버 목록과 칸 표시 · `Sidebar/LocalTerminalList.tsx`, `lib/localTerminalPane.ts`, `Sidebar/PaneLayoutBadge.tsx`, `lib/localProjectServers.ts` · [docs/architecture/sidebar.md](docs/architecture/sidebar.md)
- Sidebar Session Tab Badge — 저장 세션의 열린 탭·칸 표시와 포커스 이동 · `lib/sessionTabs.ts`, `lib/paneFocus.ts`, `Sidebar/PaneMap.css` · [docs/architecture/sidebar.md](docs/architecture/sidebar.md)
- App Name and User Data Folder — 설치 ID, 데이터 폴더와 작업 표시줄 그룹 · `main.js`, `src/userDataDir.js`, `package.json` · [docs/architecture/app-identity.md](docs/architecture/app-identity.md)
- Startup Splash (시작 화면) — 시작 모션·테마와 본창 표시 순서 · `main.js`, `startupMotions/bootPrompt.ts`, `styles/startupBoot.css`, `startup.ts` · [docs/architecture/startup-splash.md](docs/architecture/startup-splash.md)
- App Icon — 앱·타이틀바·설치본 아이콘 생성과 사용 · `assets/icon.svg`, `scripts/build-icon.cjs`, `scripts/ico.cjs`, `scripts/icns.cjs` · [docs/architecture/app-identity.md](docs/architecture/app-identity.md)
- Cross-platform / macOS build — macOS 패키징·서명·업데이트·메뉴·키 처리 · `package.json`, `.github/workflows/mac-build.yml`, `scripts/mac-adhoc-sign.cjs`, `src/manualUpdate.js`, `src/macMenu.js` · [docs/architecture/macos.md](docs/architecture/macos.md)
- Agent State From Official Signals (훅으로 받는 에이전트 상태) — Claude·Codex 훅, 상태 우선순위와 메시지 깨우기 · `src/agentHookReport.js`, `src/ipc/agentHookState.js`, `src/ipc/codexHookLaunch.js`, `src/localShell.js` · [docs/architecture/agent-hooks.md](docs/architecture/agent-hooks.md)
- MCP Server (Claude Code) — SSH·메시지 MCP, 받은편지함과 관계도 · `src/mcp/controller.js`, `src/ipc/agentMessages.js`, `src/ipc/agentMessageMcp.js`, `Terminal/AgentMessages.tsx` · [docs/architecture/mcp-and-agent-messages.md](docs/architecture/mcp-and-agent-messages.md)
- Session Log (터미널 출력을 파일로 저장) — SSH 터미널 출력 저장과 줄 수집 · `src/sessionLog/sessionLogger.js`, `src/sessionLog/logFile.js`, `src/sessionLog/lineRecorder.js` · [docs/architecture/terminal-logs.md](docs/architecture/terminal-logs.md)
- Root Switch (로그인 후 su -) — 로그인 뒤 root 셸로 전환 · `src/rootSwitch.js`, `lib/rootSwitch.ts`, `src/ipc/sshSessions.js` · [docs/architecture/ssh-connections.md](docs/architecture/ssh-connections.md)
- SFTP Local Path Bar (바로 가기·드라이브) — 로컬 주소줄의 바로 가기와 드라이브 목록 · `PathBar.tsx`, `lib/pathSuggestions.ts`, `src/localPlaces.js` · [docs/architecture/sftp-local-places.md](docs/architecture/sftp-local-places.md)
- Server File Window (SFTP 미리보기·편집) — SFTP 파일 탐색·미리보기·편집·실시간 로그 · `RemoteFileWindow.tsx`, `src/remoteFiles/ipc.js`, `src/remoteFiles/documents.js`, `FileExplorer.tsx` · [docs/architecture/remote-files.md](docs/architecture/remote-files.md)
- Config Placeholder Definitions (설정 파일 `${NAME}` 의 정의 찾기) — 설정 변수 참조에서 정의 찾기 · `RemoteFile/placeholderLinks.ts`, `RemoteFile/DefinitionList.tsx`, `src/remoteFiles/configRefs.js` · [docs/architecture/remote-files.md](docs/architecture/remote-files.md)
- Container Panel (도커 컨테이너·컨테이너 로그) — 원격 컨테이너 목록·명령·로그 · `Terminal/ContainerPanel.tsx`, `src/containers/ipc.js`, `src/containers/exec.js`, `src/containers/logs.js` · [docs/architecture/containers.md](docs/architecture/containers.md)
- DB Client (SSH 터널로 DB 조회) — SSH 터널을 통한 DB 연결·쿼리와 권한 검사 · `src/dbClient/ipc.js`, `src/dbClient/localTunnel.js`, `src/dbClient/sqlGuard.js`, `DbClientView.tsx` · [docs/architecture/database-client.md](docs/architecture/database-client.md)
- Remote Access (휴대폰 브라우저, Tailscale) — 인증된 휴대폰의 SSH·탭 공유·에이전트 채팅 · `src/remoteAccess/controller.js`, `src/remoteAccess/server.js`, `src/remoteAccess/accessStore.js`, `src/remoteAccess/agentBridge.js` · [docs/architecture/remote-access.md](docs/architecture/remote-access.md)
- SSH Algorithms (오래된 서버) — 레거시 서버 호환 알고리즘과 런타임 필터 · `src/sshAlgorithms.js`, `src/sshConnectionTest.js`, `src/ipc/sshSessions.js` · [docs/architecture/ssh-connections.md](docs/architecture/ssh-connections.md)
- SSH Host Key Verification — 서버 키 확인과 변경 처리 · `src/hostKeys/hostKeyCheck.js`, `src/hostKeys/hostKeyStore.js`, `HostKeyDialog.tsx` · [docs/architecture/ssh-connections.md](docs/architecture/ssh-connections.md)
- Connection Lost Overlay (탭 연결 끊김) — SSH 연결 끊김 안내와 재연결 · `ConnectionLostOverlay.tsx`, `lib/connectionLost.ts`, `src/ipc/sshSessions.js` · [docs/architecture/ssh-connections.md](docs/architecture/ssh-connections.md)
- macOS Themes (모양까지 바꾸는 테마) — macOS 테마의 색과 창 모양 · `themes/macosPresets.ts`, `styles/themes-macos.css`, `lib/defaultTheme.ts` · [docs/architecture/appearance.md](docs/architecture/appearance.md)
- Glass Surface and Window Opacity (표면 스타일·창 투명도) — 아크릴 재질, 창 투명도와 설정 백업 · `lib/appearance.ts`, `src/nativeBackdrop.js`, `styles/glass.css`, `lib/uiSettingsBackup.ts`, `lib/uiSettingsApply.ts` · [docs/architecture/appearance.md](docs/architecture/appearance.md)
- Themed Tooltips (title 안내를 앱이 그린다) — 테마를 따르는 툴팁과 위치 계산 · `lib/themedTooltip.ts`, `lib/tooltipPosition.ts`, `styles/tooltip.css` · [docs/architecture/appearance.md](docs/architecture/appearance.md)
- Pointer Appearance (마우스 포인터 모양·효과) — 포인터 모양·효과와 커서 변수 변환 · `Settings/PointerSettings.tsx`, `lib/pointerAppearance.ts`, `lib/pointerEffects.ts`, `scripts/postcss-cursor-vars.cjs` · [docs/architecture/appearance.md](docs/architecture/appearance.md)
- Work Overview Shortcut From Any Program (다른 프로그램에서도 단축키로 작업 개요) — 전역 키로 작업 개요 열기와 모니터 배치 · `src/globalDoubleTab.js`, `src/ipc/workOverview.js`, `Sidebar/WorkOverview.tsx` · [docs/architecture/global-shortcuts.md](docs/architecture/global-shortcuts.md)
- Quick Capture (영역 캡처·표시·바로작업) — 영역 캡처·편집과 에이전트 바로작업 · `src/quickCapture.js`, `src/quickCaptureOverlay.js`, `src/quickCaptureEditor.js`, `src/globalDoubleTab.js` · [docs/architecture/quick-capture.md](docs/architecture/quick-capture.md)
- Byte Daemon (상태 줄에 숨긴 미니 게임) — 상태 줄 게임과 상태 저장 · `ByteDaemon/ByteDaemonStatus.tsx`, `lib/byteDaemonGames.ts`, `stores/byteDaemonStore.ts` · [docs/architecture/byte-daemon.md](docs/architecture/byte-daemon.md)
- Keyboard Shortcuts (단축키와 사용자 지정) — 사용자 지정 앱 단축키와 키 매칭 · `stores/shortcutsStore.ts`, `hooks/useKeyboardShortcuts.ts`, `lib/shortcutCapture.ts` · [docs/architecture/global-shortcuts.md](docs/architecture/global-shortcuts.md)
- LockScreen Safe API Pattern — 잠금 화면에서 preload API 유무 확인 · `LockScreen/LockScreen.tsx`, `src/preload.js` · [docs/architecture/lock-screen.md](docs/architecture/lock-screen.md)

## Tech Stack
- Electron 45 (Chromium 156, Node 24) + electron-vite 5
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
