# macOS 지원

작성일: 2026-11-17
상태: 계획 (착수 전, 진행 방향 확인 대기)

## 목표

지금은 Windows 전용으로 패키징되는 ezShell 을 macOS 에서도 실행·사용할 수 있게 한다.

## 결론 요약

- **코드 차원**: 상당 부분이 이미 플랫폼을 구분하도록(`platform` 파라미터, `darwin`/`linux` 분기) 작성되어 있어, 남은 Windows 전용 가정 몇 군데만 macOS 분기를 더하면 된다.
- **빌드·배포 차원**: 두 가지 실제 제약이 있다.
  1. **macOS 바이너리는 Windows 에서 만들 수 없다.** `.dmg`/`.app` 과 네이티브 의존성(`node-pty`, `oracledb`)의 mac 빌드는 macOS(사용자 Mac 또는 macOS CI 러너)가 있어야 한다. 이 Windows 개발기에서는 코드 작성·타입 체크·단위 테스트까지만 가능하고, 실제 mac 실행 검증은 불가능하다.
  2. **정식 배포와 자동 업데이트에는 Apple 코드 서명·공증이 필요하다.** `electron-updater`(Squirrel.Mac)는 서명된 앱에서만 자동 업데이트가 동작하고, 서명이 없으면 Gatekeeper 가 "확인되지 않은 개발자" 로 막는다(개인용으로는 우클릭 열기·ad-hoc 서명으로 실행 가능). 서명에는 Apple Developer 계정(연 $99)이 필요하다.

## 현재 코드 상태 (조사 결과)

### 이미 플랫폼을 구분하는 곳 (추가 작업 적음)
- `src/localShell.js`: win32→PowerShell, 그 외→`$SHELL`/zsh/bash. macOS 는 이미 처리됨.
- `src/localPlaces.js`: win32→드라이브, 그 외→unix 경로.
- `src/remoteAccess/tailnet.js`: darwin→`utunN`, 그 외→`tailscale` 이름. macOS Tailscale 주소 탐지 처리됨.
- `src/remoteAccess/tailscaleCert.js`: `programs()` 가 win32 분기. macOS 의 `tailscale` 경로 추가 필요.
- `src/sessionImport/sources.js`: PuTTY(레지스트리)·Xshell 등은 win32 에서만. Tabby 는 darwin 경로 있음. macOS 는 OpenSSH config·Tabby·Termius(내보내기)만 노출.
- `src/mcp/tokenEnv.js`: win32 외에는 `unsupported` 반환(PowerShell 로 사용자 환경 변수 설정). macOS 는 `~/.claude.json` 전체 등록 경로로 안내하거나 shell rc 안내가 필요.
- `src/dbClient/oracleClient.js`: Instant Client 설치는 `win32 && x64` 만 지원. macOS 는 thin 방식(Oracle 12.1+)만 가능하고 thick(구버전 접속)은 미지원 — 제약으로 안내.
- `main.js:874`: `window-all-closed` 에서 darwin 은 종료하지 않음(표준 mac 동작) — 이미 처리됨.
- `main.js:24`: `setAppUserModelId` 는 win32 에서만 — 분기 되어 있음.

### macOS 분기·추가가 필요한 곳
- **빌드 설정(`package.json` build)**: `mac` 타깃(dmg/zip), `build.mac`(category, hardenedRuntime, entitlements), `.icns` 아이콘 추가. `scripts/build-icon.cjs` 가 `.icns` 도 만들도록 확장(또는 별도 스크립트).
- **키보드 단축키**: 지금은 `ctrlKey` 기준(`useKeyboardShortcuts.ts`, `terminalClipboard.ts` 등 36개 파일). macOS 는 Cmd(`metaKey`)가 기본이라, 플랫폼에 따라 주 수정키를 Cmd/Ctrl 로 바꾸는 매핑이 필요(복사·붙여넣기·찾기·탭 닫기 등). 터미널 안의 Ctrl 키(SIGINT 등)는 그대로 둔다.
- **애플리케이션 메뉴**: macOS 는 상단 메뉴 막대가 필수적(복사/붙여넣기/최소화/종료 등). 지금은 커스텀 타이틀바만 있을 수 있으니, mac 용 기본 Menu 를 구성.
- **창 컨트롤/타이틀바**: macOS 의 신호등 버튼과 커스텀 타이틀바가 겹치지 않도록 `titleBarStyle`(`hiddenInset`)·좌측 여백 처리.
- **네이티브 의존성**: `node-pty` 는 mac(arm64/x64) 사전 빌드 사용 가능. `oracledb` thick 네이티브는 mac Instant Client 미지원이라 thin 전용. `asarUnpack`·`npmRebuild: false` 영향 재확인.
- **아이콘·문서 경로**: `문서\ezShell Logs` 등 Windows 경로 표기를 쓰는 사용자 대면 문구 점검(실제 경로는 `app.getPath` 라 동작엔 문제없음, 안내 문구만).

## 단계 구분

- **Phase 1 — 코드 크로스플랫폼화 (지금 Windows 에서 가능)**
  - 위 "분기·추가가 필요한 곳" 중 코드/설정 작업: 빌드 설정에 mac 타깃·`.icns`, 키보드 단축키 플랫폼 매핑, mac 애플리케이션 메뉴, 타이틀바 분기, tailscaleCert/tokenEnv 의 mac 경로.
  - 단위 테스트는 `platform` 파라미터로 darwin 분기까지 덮는다(기존 테스트 방식과 동일).
  - 산출물: Windows 에서 타입 체크·테스트·빌드가 깨지지 않는 상태의 크로스플랫폼 코드.
- **Phase 2 — macOS 실제 빌드·실행 검증 (Mac 또는 macOS CI 필요)**
  - mac 에서 `electron-builder --mac` 로 `.app`/`.dmg` 생성, 네이티브 의존성 포함 확인.
  - 실행 검증: 터미널/SFTP/DB/MCP/원격 접속/세션 가져오기 등 주요 흐름.
- **Phase 3 — 서명·공증·자동 업데이트 (Apple Developer 계정 필요)**
  - Developer ID 로 서명·공증, `electron-updater` 의 mac 자동 업데이트 채널 구성, GitHub 릴리스에 mac 자산 추가.
  - 계정이 없으면 생략하고 "개인용 비서명 실행"(우클릭 열기)만 안내.

## 결정 사항 (2026-11-17 사용자 확인)

- 빌드 환경: **Mac 없음 → GitHub Actions 의 macOS 러너로 빌드.**
- 목표 수준: **개인용 실행만(비서명).** 서명·공증·mac 자동 업데이트는 하지 않는다(Phase 3 보류). 사용자는 CI 산출물(`.dmg`/`.zip`)을 내려받아 우클릭 열기로 실행한다.

이에 따른 범위:
- `icon.icns` 는 mac 도구 없이 Windows 에서 PNG 를 ICNS 컨테이너로 직접 포장해 만든다(`scripts/icns.cjs`, 기존 `ico.cjs` 방식). 저장소에 커밋해 CI 가 바로 쓴다.
- 애플리케이션 메뉴는 당장 따로 만들지 않는다. macOS 는 메뉴를 설정하지 않으면 **기본 편집 메뉴**(Cmd+C/V/X/A/Z, Cmd+Q/W/M/H)가 적용되므로 기본 단축키는 동작한다.
- 창을 닫아도 darwin 은 종료하지 않으므로(`main.js:874`), **`activate` 처리기**를 더해 Dock 아이콘으로 창을 다시 연다(지금은 없어서 창을 닫으면 되돌릴 길이 없다).
- 커스텀 타이틀바(`frame: false`)와 자체 창 컨트롤은 mac 에서도 그대로 동작한다. 네이티브 신호등 버튼 전환은 하지 않는다(Phase 1.5 후보).
- 렌더러 단축키의 Cmd/Ctrl 매핑은 mac 실행 검증이 가능해질 때 다루는 **Phase 1.5** 로 미룬다(지금은 Ctrl 고정, 기본 편집 단축키는 메뉴로 보완).
- Oracle 은 mac 에서 thin(12.1+) 전용. thick(구버전) 미지원은 계정 창에서 안내.
- 업데이트(2026-11-17 추가): mac 은 스스로 업데이트하지 않고, 새 릴리스에 이 아키텍처의 `.dmg` 가 붙으면 알림의 `다운로드 페이지` 로 릴리스 페이지를 연다 (`src/manualUpdate.js`). 워크플로는 릴리스 공개 때 빌드해 그 릴리스에 파일을 붙인다.
- mac 기본 테마(2026-11-17, 테마 작업 세션이 구현): 저장된 테마가 없는 첫 실행에서 macOS 면 `macos-dark`/`macos-light` (`lib/defaultTheme.ts`).

## 진행 상황

- [x] Phase 1: `build.mac`, `icon.icns`, 창 종료 동작, CI 워크플로, 업데이트 안내 (Windows 에서 typecheck·테스트·빌드 통과)
- [ ] 첫 CI 빌드 실행 (커밋·푸시 필요), mac 에서 실행 확인
- [ ] Phase 1.5: 단축키 Cmd/Ctrl 매핑, 타이틀바 신호등 처리 확인
