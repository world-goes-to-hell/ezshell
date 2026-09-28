# My SSH Client - CLAUDE.md

## Project Overview

Electron 기반 SSH 클라이언트 데스크톱 앱. 한국어 UI.
메인 프로세스(Node.js + ssh2)와 렌더러 프로세스(React + xterm.js + Zustand)로 구성.

## Build & Run

```bash
npm run dev             # 개발 모드 (electron-vite dev)
npm run build           # 번들 빌드 (electron-vite build → out/)
npm run typecheck       # TypeScript 타입 체크 (tsc --noEmit)
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
모든 SplitTerminal은 같은 트리 레벨에 안정적 key (`key="w-split-1"`) 사용.
레이아웃 전환(quad/tri) 시 불필요한 unmount/remount 방지.

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
