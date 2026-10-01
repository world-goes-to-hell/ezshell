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
- 도구: `list_sessions`, `cd`, `run_command`. 세션 편집 > 고급 설정의 "MCP 접근 허용"(`mcpEnabled`)을 켠 세션만 보인다.
- 명령은 `commandPolicy.js` 가 낮음/중간/위험/절대 차단으로 판정한다. 처음 보는 명령은 위험. 위험은 항상 앱 확인 창(60초 안에 응답 없으면 거부), 절대 차단은 실행 불가.
- 설정은 `userData/mcp.json`(main 전용), 감사 로그는 `userData/mcp-audit.log`(명령과 판정만, 출력은 기록하지 않음).
- 상태바의 "MCP 활동" 패널이 요청과 상태(대기/실행/완료/거부/취소/차단)를 실시간으로 보여준다. 이 목록과 명령 출력은 메모리에만 있고 디스크에 쓰지 않는다 (출력에 비밀이 섞일 수 있음).
- 설정 > MCP 의 "Claude Code 자동 설정"(`clientSetup.js`): 프로젝트는 고른 폴더의 `.mcp.json` 에 토큰 대신 `${EZSHELL_MCP_TOKEN}` 참조를 쓰고(Windows 는 `tokenEnv.js` 가 PowerShell 절대 경로로 사용자 환경 변수 설정. 토큰은 명령줄이 아니라 stdin 으로 넘기고, 오류 메시지에 명령줄이 섞이지 않게 한다), 전체는 `~/.claude.json` 의 `mcpServers` 에 토큰을 직접 쓴다. 다른 항목은 보존하고 `<파일>.ezshell-backup` 으로 백업하며, 깨진 JSON 은 거부하고, 같은 이름 항목은 확인 후 덮어쓴다. 폴더는 main 의 선택 창으로만 고른다.
- Electron 28(Node 18)에는 `globalThis.crypto` 가 없어서 `src/mcp/sdk.js` 가 채운 뒤 SDK 를 불러온다.
- `src/mcp` 는 번들되지 않고 `electron.vite.config.ts` 가 `out/main/src/mcp` 로 복사한다.

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
