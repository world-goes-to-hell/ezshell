# Electron 업그레이드 사전 조사 (28 → 최신 안정 버전)

코드는 고치지 않은 조사 문서입니다. 공식 문서를 직접 내려받아 읽고, 변경 사항마다 저장소 코드를 검색해 해당 여부를 확인했습니다.

## 1. 결론

- **Electron 45 계열의 최신 패치(조사 시점 45.3.3)까지 올리는 것을 권장합니다.** 지원 중인 계열은 43·44·45 뿐이고, 43 은 2027-01-05, 44 는 2027-03-02 에 지원이 끝나므로 45 가 가장 오래 지원됩니다.
- 29~45 의 breaking change 가운데 이 앱이 **실행되지 않게 만드는 항목은 코드 검색으로는 찾지 못했습니다.** 해당하는 것은 모두 "아직 동작하지만 경고가 나오는 것"(`safeStorage` 동기 API, `console-message` 인자)과 동작이 달라지는 것(파일 대화상자 시작 폴더, macOS 알림·최소 버전)입니다. 네이티브 모듈(`node-pty`, `oracledb`)은 N-API 사전 빌드여서 다시 빌드하지 않아도 됩니다.
- **기능 하나가 조용히 고장 납니다 (검토에서 추가).** 32 에서 `File.path` 가 없어져, 탐색기에서 터미널로 파일을 끌어 놓는 업로드(`TerminalPanel.tsx` 의 `handleDrop`)가 아무것도 올리지 않으면서 완료라고 표시합니다. 올리기 전에 `webUtils.getPathForFile` 로 바꿔야 합니다 (3절의 32 행).
- **46 은 올리지 않습니다.** 아직 알파이고(안정 예정 2027-01-05), `safeStorage` 동기 API 가 제거되어 자동 잠금 해제와 원격 접속 봉인이 바로 깨집니다. 45 에서 문제가 생기면 44.11.3 이 대안입니다.

## 2. 버전 현황

| 항목 | 값 | 근거 |
| --- | --- | --- |
| 확인한 날짜 | 2026-11-17 (화) | 시스템 `date` |
| 현재 설치된 버전 | Electron 28.3.3 (Chromium 120, Node 18.18.2, 모듈 ABI 119) | `node_modules/electron/package.json`, releases.json |
| 최신 안정 버전 | 45.3.3 (2026-11-14, Chromium 156.0.8078.100, Node 24.22.3, 모듈 ABI 150) | https://releases.electronjs.org/releases.json |
| 다음 버전 | 46.0.0-alpha.11 (안정 예정 2027-01-05, Chromium 160, Node 26) | https://releases.electronjs.org/schedule |
| 지원 정책 | 최신 안정 3개 계열 | https://www.electronjs.org/docs/latest/tutorial/electron-timelines |

| 계열 | 상태 | 안정 출시 | 지원 종료 | 최신 패치 | Chromium | Node |
| --- | --- | --- | --- | --- | --- | --- |
| 45 | 지원 중 | 2026-10-20 | 2027-04-27 | 45.3.3 | 156 | 24.22 |
| 44 | 지원 중 | 2026-08-24 | 2027-03-02 | 44.11.3 | 152 | 24.22 |
| 43 | 지원 중 (보안 수정만) | 2026-06-29 | 2027-01-05 | 43.8.10 | 150 | 24.22 |
| 42 이하 | 지원 종료 | | 42 는 2026-10-20 | | | |
| 28 (현재) | 지원 종료 | 2023-12-04 | 2024-06 (31 출시) | 28.3.3 | 120 | 18.18 |

Node 판이 바뀌는 지점: 29 에서 Node 20, 35 에서 Node 22, 40 에서 Node 24 입니다 (releases.json 의 계열별 `node` 값).

## 3. 이 앱에 영향이 있는 변경

줄 번호는 조사 시점 작업 트리 기준입니다. `main.js` 는 조사하는 동안에도 커밋되지 않은 리팩터링(창 생성 코드를 `src/ipc/detachedWindows.js` 로 옮기는 작업 등)으로 줄이 계속 바뀌고 있었으므로, 괄호 안의 식별자로 다시 검색해 주십시오.

출처 약어: **BC** = https://www.electronjs.org/docs/latest/breaking-changes (원본 https://github.com/electron/electron/blob/main/docs/breaking-changes.md), **블로그 N** = https://www.electronjs.org/blog/electron-N-0

| Electron | 변경 내용 | 이 앱에서 해당하는 코드 | 필요한 조치 | 출처 |
| --- | --- | --- | --- | --- |
| **32** | `File.path` 가 제거되었습니다. 대체는 preload 에서 부르는 `webUtils.getPathForFile(file)` 입니다. | `src/renderer/components/Terminal/TerminalPanel.tsx` 의 `handleDrop` 이 `(file as any).path` 로 PC 경로를 얻어 `sftpQueueUpload` 에 넘깁니다 (OS 탐색기에서 터미널로 파일을 끌어 놓는 업로드). 올리면 경로가 `undefined` 가 되어 **아무것도 올리지 않으면서 "N개 파일 업로드 완료" 라고 표시합니다** (경로가 없으면 건너뛰는 `if (localPath)` 때문에 오류도 나지 않습니다). 조사 에이전트의 첫 검색(`File.path`·`webUtils` 글자)에서는 `as any` 때문에 잡히지 않았고, 검토하면서 찾았습니다. | preload 에 `webUtils.getPathForFile` 을 감싼 함수를 더하고(예: `getPathForFile(file)`) `handleDrop` 이 그것을 쓰게 합니다. 경로를 하나도 얻지 못하면 완료가 아니라 실패로 알리게 고칩니다. **올리기 전에 반드시 고쳐야 하는 유일한 코드 변경입니다.** | BC 32.0 (`File.path` removed) |
| 42 | `electron` npm 패키지가 `postinstall` 로 바이너리를 내려받지 않습니다. `electron` 을 처음 실행할 때 내려받고, `ELECTRON_SKIP_BINARY_DOWNLOAD` 는 없어졌습니다. | `electron-vite` 5.0.0 의 `getElectronPath()` 는 `node_modules/electron/path.txt` 를 직접 읽고 없으면 `Electron uninstall` 오류를 냅니다 (`node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:141`). `npm run dev` 가 여기에 걸립니다. `e2e/run.js:74` 의 `require('electron')` 과 `npm run build:icon` 은 `electron` 패키지의 `index.js` 가 스스로 내려받습니다. | `npm ci`/`npm install` 뒤에 `npx install-electron --no` 를 한 번 실행하는 절차를 넣습니다 (개발 PC, CI). | BC 42.0, 블로그 42, `electron@45.3.3` 패키지의 `index.js` |
| 45 (패키지) | `electron@45.3.3` 의 `engines.node` 는 `>= 22.12.0` 입니다. | `.github/workflows/mac-build.yml:40` 이 `node-version: 20` 입니다. 개발 PC 는 Node 24.12.0 이라 문제없습니다. | 워크플로의 Node 를 22.12 이상(권장 24)으로 올립니다. | https://registry.npmjs.org/electron/45.3.3 |
| 45 (사용 중단) → 46 (제거) | `safeStorage.isEncryptionAvailable()`, `encryptString()`, `decryptString()` 동기 메서드가 45 에서 사용 중단되고 46 에서 제거됩니다. 대체는 `isAsyncEncryptionAvailable()`, `encryptStringAsync()`, `decryptStringAsync()` 이며 (`decryptStringAsync` 는 `{ result }` 를 돌려줌), 같은 키 저장소를 써서 예전 자료가 그대로 풀립니다. 비동기 API 는 42 에서 들어왔습니다. | `main.js:571-573` (원격 접속 `sealer` 의 `isAvailable`/`seal`/`unseal`), `main.js:701,704` (`save-auto-unlock`), `main.js:720,724` (자동 잠금 해제 읽기). `src/remoteAccess/controller.js:79` 의 `deps.sealer` 가 동기 인터페이스입니다. | 45 에서는 경고만 나오고 동작합니다. 46 으로 가기 전에 비동기로 바꿉니다. 원격 접속의 `sealer` 를 쓰는 쪽(`accessStore` 등)까지 `await` 로 바꿔야 하므로 범위를 미리 잡아 둡니다. | BC 45.0·46.0, https://www.electronjs.org/docs/latest/api/safe-storage, 블로그 42 |
| 35 (사용 중단) → 47 (제거) | `WebContents` 의 `console-message` 이벤트에서 `level, message, line, sourceId` 위치 인자가 사용 중단되었습니다. `Event` 객체의 속성(`{ level, message, lineNumber, sourceId }`)으로 받아야 하고 `level` 은 문자열입니다. | `main.js:286` `mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => …)` (개발 모드에서 `message` 만 사용). | `(event) => console.log(event.message)` 형태로 바꿉니다. 45 에서는 경고만 나옵니다. | BC 35.0·47.0 |
| 43 | `dialog.showOpenDialog`/`showSaveDialog` 에 `defaultPath` 를 주지 않으면 다운로드 폴더에서 시작합니다. OS 가 마지막으로 연 폴더를 기억하던 동작이 없어집니다. | `defaultPath` 없음: `main.js:1032` (Claude Code 프로젝트 폴더), `:1041` (MCP 전송 허용 폴더), `:1092` (세션 가져오기), `:1231` (Private Key 파일), `src/ipc/sftp.js:293` (업로드할 파일), `:367` (로컬 폴더), `src/sessionImport/ipc.js:29`. 파일 이름만 주는 곳: `main.js:469`, `:582`, `:1067`, `src/ipc/sftp.js:279`. | 마지막 폴더를 기억해야 하는 대화상자(Private Key, 업로드, 세션 가져오기)는 앱이 마지막 폴더를 기억해서 `defaultPath` 로 넘길지 정합니다. 파일 이름만 넘기는 저장 대화상자가 어느 폴더에서 열리는지는 문서에 없어 직접 확인합니다 (7장). | BC 43.0 |
| 42 | macOS 알림이 `UNNotification` 으로 바뀌어, 코드 서명되지 않은 앱은 알림이 뜨지 않고 `Notification` 에 `failed` 이벤트가 납니다. | `main.js:946` `new Notification(...)` (MCP 확인 요청 알림). macOS 빌드는 `identity: null` + `scripts/mac-adhoc-sign.cjs` 의 임시(ad-hoc) 서명입니다. | 임시 서명이 "서명됨"으로 인정되는지는 문서에 없습니다 (7장). 인정되지 않으면 macOS 에서 알림이 사라지므로, `failed` 를 듣고 Dock 튀기기(`flashFrame`)만으로 충분한지 판단합니다. | BC 42.0, 블로그 42 |
| 33·38·44 | macOS 최소 버전이 올라갑니다: 33 에서 11, 38 에서 12, **44 에서 13(Ventura)**. | `package.json` 의 `build.mac`, `docs/plan/2026-11-17-macos-support.md` 의 대상 범위. | 45 로 올리면 macOS 12 이하에서는 실행되지 않습니다. 릴리스 노트에 적고, 필요하면 `build.mac.minimumSystemVersion` 을 13 으로 둡니다. | BC 33.0·38.0·44.0, https://github.com/electron/electron/blob/main/README.md (Platform support) |
| 35·36 (수정) | 아크릴/마이카 창 수정 두 건: "최대화하면 `backgroundMaterial` 효과를 잃던 문제 완화"(#45456), "프레임 없는 창에서 처음 만들 때 `backgroundMaterial` 이 그려지지 않던 문제"(#46657, 35·36 으로도 반영). breaking change 는 아니지만 이 앱의 우회 코드가 정확히 이 두 증상을 다룹니다. | `src/nativeBackdrop.js:55` (`backgroundMaterial: 'acrylic'`, `backgroundColor: '#00000000'`, `maximizable: false`), `main.js:55-69` (`createFillToggle`, `hookWindowMessage(WM_PARENTNOTIFY, …)`). | 우회를 그대로 둔 채 올리고, 아크릴 창이 전과 같이 그려지는지 먼저 확인합니다 (6장). 그 뒤 `maximizable: false`·작업 영역 채우기 우회를 걷어낼 수 있는지 따로 시험합니다. #45456 은 "최대화 애니메이션이 사라진다"고 적혀 있습니다. | https://github.com/electron/electron/pull/45456, https://github.com/electron/electron/pull/46657 |
| 41 | PDF 가 별도 `WebContents`(게스트)가 아니라 같은 `WebContents` 안의 프레임(OOPIF)으로 그려집니다. | `src/renderer/components/RemoteFile/RemotePreviewView.tsx:24` (`<iframe src={blob URL}>` PDF 미리보기), `src/renderer/index.html:6` 의 CSP `frame-src blob:`, `main.js:306` `web-contents-created` → `src/navigationGuard.js:54-57`. | 코드 변경이 필요한지는 실행해 봐야 압니다. PDF 미리보기가 CSP 와 이동 차단에 걸리지 않는지 확인합니다 (6장). | BC 41.0 |
| 31 | macOS 에서 `flashFrame(true)` 가 `flashFrame(false)` 를 부를 때까지 Dock 아이콘을 계속 튀깁니다 (전에는 한 번). | `main.js:944` (MCP 확인 요청), `src/remoteFiles/ipc.js:118` (실시간 보기의 새 오류). 둘 다 `focus` 에서 `flashFrame(false)` 를 부릅니다. | 조치 없음. macOS 에서 동작이 달라지는 것만 알아 둡니다. | BC 31.0 |
| 29~40 (Node) | main 프로세스의 Node 가 18 → 24 로 바뀝니다. | `src/mcp/sdk.js:3-5` (`globalThis.crypto` 채우기), `src/mcp/signals.js` (`AbortSignal.any` 대체), `src/dbClient/drivers/mssql.js:15-30` (`loadTedious`). | 아래 "Node 18 우회 코드" 참고. | releases.json, https://nodejs.org/docs/latest-v24.x/api/globals.html |
| 28 → 45 (BoringSSL) | Electron 이 쓰는 암호 라이브러리가 함께 바뀝니다. Electron 문서에는 항목이 없습니다. | `src/sshAlgorithms.js:24-29` 는 `ssh2` 가 런타임에서 지원한다고 판단한 이름(`SUPPORTED_KEX` 등)만 붙입니다. 런타임이 `3des-cbc`, `ssh-dss`, `hmac-md5`, SHA-1 키 교환 중 하나를 더 이상 지원하지 않으면 오류 없이 목록에서 빠지고, 오래된 서버 접속만 실패합니다. | 올린 뒤 `SSH_ALGORITHMS` 의 내용을 28 과 비교합니다 (6장). | 확인하지 못함 (7장) |

### Node 18 우회 코드를 걷어낼 수 있는지

| 우회 코드 | 판단 | 근거 |
| --- | --- | --- |
| `src/mcp/sdk.js` 의 `globalThis.crypto = require('crypto').webcrypto` | 걷어낼 수 있습니다. 전역 `crypto` 는 Node 19 부터 플래그 없이 있고 23 에서 실험 딱지가 떨어졌습니다. 다만 `if (!globalThis.crypto)` 조건이 있어 그대로 두어도 해가 없으므로, 올린 뒤 main 에서 `typeof globalThis.crypto` 를 한 번 찍어 보고 지웁니다. | Node 24 `globals.md` 의 `crypto` 변경 이력 (https://github.com/nodejs/node/blob/v24.x/doc/api/globals.md) |
| `src/mcp/signals.js` 의 `combineSignals` | `AbortSignal.any()` 로 바꿀 수 있습니다 (Node 20.3.0, 18.17.0 에 추가). 급하지 않습니다. | 같은 문서의 `AbortSignal.any` |
| `src/dbClient/drivers/mssql.js` 의 `loadTedious` (`@azure/*` 요청에 빈 대역으로 답함) | **걷어내면 안 됩니다.** 설치된 `@azure/identity` 4.14.1·`@azure/core-auth` 1.11.0 은 `engines.node >=22` 라서 Node 24 에서는 로드 조건을 충족하지만, `package.json` 의 `build.files` 가 `@azure`, `@typespec` 을 설치본에서 뺍니다 (약 45MB). 우회를 지우면 설치본에서 `tedious` 가 로드되지 않습니다. 주석의 이유("Electron 28 의 Node 가 낮아서")만 "설치본에서 빼기 위해서"로 고치면 됩니다. | `node_modules/@azure/*/package.json` 의 `engines`, `package.json` 의 `build.files` |

## 4. 살펴봤지만 영향이 없는 변경

검색 범위는 `main.js`, `src/`(렌더러 포함), `scripts/`, `e2e/`, `electron.vite.config.ts` 입니다.

- **29: `ipcRenderer` 를 `contextBridge` 로 통째로 넘길 수 없음.** `src/preload.js` 는 함수로 감싼 `electronAPI` 만 내보내고 `ipcRenderer` 객체를 넘기지 않습니다.
- **29: `renderer-process-crashed`, `crashed`, `gpu-process-crashed` 이벤트 제거.** 쓰지 않습니다.
- **30: `BrowserView` 사용 중단, 교차 출처 iframe 의 Permission Policy, `process.getIOCounters()` 제거.** 쓰지 않습니다. iframe 은 같은 출처의 `blob:` PDF 하나뿐입니다.
- **31: WebSQL 제거, 32: `userData/databases` 폴더 삭제.** WebSQL 을 쓰지 않고 `userData` 아래에 `databases` 폴더를 만들지 않습니다.
- **32: `File.path` 제거 (SFTP 패널 쪽).** SFTP 끌어 놓기(`Sftp/FileList.tsx` 의 `handleDrop`)는 앱 안의 끌기 형식(`FILE_LIST_DRAG_TYPE`)만 읽고 OS 에서 끌어온 파일은 받지 않으며, 파일 선택은 모두 main 의 `dialog` 입니다. 다만 터미널에 파일을 끌어 놓는 업로드는 `File.path` 를 씁니다: 3절의 32 행을 보십시오.
- **32: `webContents.goBack` 등 탐색 API 사용 중단.** 쓰지 않습니다.
- **33: `event.senderFrame` 이 `null` 일 수 있음.** `senderFrame` 을 쓰지 않습니다. 보낸 창 확인은 `event.sender`(`main.js` 의 `fromMainWindow`, `event.sender.id`)이며 변경이 없습니다.
- **33: `document.execCommand('paste')` 사용 중단.** 쓰지 않습니다 (`navigator.clipboard` 만 사용).
- **33: 네이티브 모듈 C++20 요구.** 네이티브 모듈을 빌드하지 않습니다 (`npmRebuild: false`, 사전 빌드 사용).
- **33: 사용자 지정 프로토콜 URL 처리, 36·37: `ProtocolResponse.session`.** `protocol` 모듈을 쓰지 않습니다.
- **34: Windows 전체 화면에서 메뉴 막대 숨김.** 창이 모두 `frame: false` 이고 Windows 에는 메뉴 막대가 없습니다.
- **35: `session.setPreloads` 사용 중단, `WebRequestFilter` 의 빈 `urls`, 36: `session` 의 확장 프로그램 메서드.** `session`, `webRequest` 를 쓰지 않습니다 (CSP 는 `index.html` 의 meta 태그).
- **36: `app.commandLine` 이 스위치를 소문자로 바꿈.** `main.js:10` 의 `hasSwitch('user-data-dir')` 는 이미 소문자입니다.
- **35·36: `systemPreferences.isAeroGlassEnabled()` 제거, 33: `accessibilityDisplayShouldReduceTransparency` 사용 중단.** `systemPreferences` 를 쓰지 않습니다.
- **37·46: `utilityProcess` 동작 변경.** 쓰지 않습니다.
- **38: `webFrame.routingId` 사용 중단.** `src/preload.js` 는 `webFrame` 의 확대/축소 메서드만 씁니다.
- **38·43: Linux 전용 변경(Wayland 기본, 둥근 모서리, `showHiddenFiles`).** Linux 빌드가 없습니다.
- **39: `window.open` 팝업이 항상 크기 조절 가능, 45: `window.open` 자식 창의 샌드박스.** `navigationGuard.js:57` 이 모든 새 창을 거부합니다.
- **39: `desktopCapturer` 의 `NSAudioCaptureUsageDescription`, 45: 화면 캡처 권한 `display-capture`, 45: `chromeMediaSource`.** 화면 캡처를 쓰지 않습니다.
- **40 (사용 중단)·44 (제거): 렌더러의 `clipboard` 모듈, 44: `clipboard` 모듈 비동기화.** main·preload 어디에서도 Electron 의 `clipboard` 모듈을 쓰지 않습니다. 렌더러는 `navigator.clipboard.readText/writeText` 만 씁니다.
- **41: 쿠키 `changed` 이벤트의 원인 값, 42: `clearStorageData` 의 `quotas`.** 쓰지 않습니다.
- **42: 오프스크린 렌더링 배율, 43: `NativeImage.toBitmap()` 색 공간, 46: `capturePage` 배율.** `scripts/build-icon.cjs` 가 아이콘을 그릴 때 이 계열을 쓰는지는 따로 봐야 합니다 (7장). 앱 본체는 쓰지 않습니다.
- **44: Windows 32비트(ia32) 바이너리 제거.** 빌드 대상이 x64 뿐입니다.
- **44: ANGLE 정적 링크(`libEGL.dll`, `libGLESv2.dll` 없어짐), 로그인 항목 속성 제거, `select-client-certificate`.** 해당 파일·API 를 다루지 않습니다.
- **45: 샌드박스 preload 에서 `Buffer`, `setImmediate`, `events`/`timers`/`url` 제거.** 창은 모두 `sandbox: true` 이지만 `src/preload.js` 와 빌드 결과(`out/preload/index.js`)는 `require('electron')` 하나만 쓰고 `Buffer`·`setImmediate` 가 없습니다. 앞으로 preload 에 이런 코드를 넣지 않도록 주의합니다.
- **45: ASAR 안 파일의 파일 디스크립터는 `fs` 로만 쓸 수 있음.** ASAR 안의 파일을 네이티브 모듈이나 자식 프로세스에 넘기는 코드가 없습니다. `node-pty` 와 `oracledb/build` 는 `asarUnpack` 으로 풀려 있고, 원격 접속의 정적 파일은 `fs.readFile` 로 읽습니다 (`src/remoteAccess/server.js:225`).
- **45: `contentTracing`, `crashReporter` 의 WER 도우미(`electron_wer.dll`).** 둘 다 쓰지 않습니다. `crashReporter.start()` 를 나중에 쓰게 되면 `electron-builder` 24 는 이 DLL 이름을 실행 파일 이름에 맞춰 바꾸지 않는다는 점을 기억해야 합니다.
- **46: http(s) 페이지의 `unload` 처리기 비활성.** `unload` 를 쓰지 않고 페이지도 `file:` 입니다.
- **변경 없음으로 확인한 API:** `hookWindowMessage`, `setOpacity`, `setBackgroundMaterial`, `backgroundMaterial` 옵션은 현재 문서에 그대로 있습니다 (https://www.electronjs.org/docs/latest/api/browser-window). `frame: false`, `maximizable`, `shell.trashItem/openExternal/openPath`, `nativeTheme.themeSource`, `powerMonitor.getSystemIdleTime`, `screen.getAllDisplays/getDisplayMatching`, `app.getPath`, `app.setAppUserModelId`, `app.getVersion`, `before-quit`, `window-all-closed`, `will-navigate`, `will-redirect`, `setWindowOpenHandler`, `contextIsolation`/`sandbox`/`nodeIntegration` 은 29~47 의 breaking changes 에 항목이 없습니다. `titleBarStyle` 과 단일 인스턴스 잠금(`requestSingleInstanceLock`)은 이 앱이 쓰지 않습니다.

## 5. 의존성 호환

| 패키지 | 설치된 버전 | 새 Electron(45) 에서의 상태 | 근거 |
| --- | --- | --- | --- |
| `node-pty` | 1.1.0 (최신 안정판) | 다시 빌드하지 않고 동작할 것으로 판단합니다. 사전 빌드가 N-API 입니다. | `prebuilds/win32-x64/pty.node`·`conpty.node` 에 `napi_*` 심볼만 있고 `node_module_register` 가 없음, 의존성 `node-addon-api ^7.1.0`, README 의 "Node.JS 16 or Electron 19 is required". `build/Release` 에는 `conpty` 폴더만 있어 `lib/utils.js` 가 `prebuilds/` 를 씁니다. 실제 동작은 6장에서 확인. |
| `oracledb` | 26.0.0 (최신) | 다시 빌드하지 않고 동작할 것으로 판단합니다. N-API 사전 빌드입니다. thin 방식은 순수 JS 입니다. | `build/Release/oracledb-26.0.0-win32-x64.node` 에 `napi_*` 심볼만 있음, 빌드 정보 파일에 "v22.17.1" 로 빌드, `engines.node >=14.17`. 사전 빌드는 win32-x64, darwin-arm64, linux 만 있고 darwin-x64 는 없습니다 (thick 방식은 원래 Windows x64 전용이라 영향 없음). |
| `ssh2` | 1.17.0 (최신) | ABI 영향이 없습니다. 선택적 네이티브 부분이 설치돼 있지 않아 순수 JS 경로로 동작합니다. 지원 알고리즘 목록은 런타임 암호 라이브러리에 따라 달라질 수 있습니다. | `node_modules/cpu-features` 없음, `ssh2/lib/protocol/crypto/build/Release` 에 `.node` 없음, `engines.node >=10.16.0`. |
| `mysql2` | 3.24.6 (최신) | 순수 JS, 문제없을 것으로 판단합니다. | `engines.node >= 8.0` |
| `pg` / `pg-cursor` | 8.23.1 / 2.22.1 | 순수 JS(`pg-native` 미설치), 문제없을 것으로 판단합니다. | `engines.node >= 16.0.0` |
| `tedious` | 18.6.2 (최신은 20.3.9, Node 22 이상 요구) | 동작할 것으로 판단합니다. `loadTedious` 우회는 유지합니다 (3장). Electron 45 로 올리면 20.x 로 올릴 수 있게 됩니다. | `engines.node >=18`, npm 레지스트리 |
| `@modelcontextprotocol/sdk` | 1.31.0 | 동작할 것으로 판단합니다. | `engines.node >=18` |
| `electron-vite` | 5.0.0 (최신은 6.0.0) | 빌드는 됩니다. 5.0.0 은 Electron 39 까지만 대상 표가 있고, 모르는 버전은 표의 마지막 값(`node22.20`, `chrome142`)으로 빌드합니다. 실행에는 지장이 없고 최신 문법을 조금 더 낮춰 변환할 뿐입니다. `npm run dev` 는 `path.txt` 문제(3장)가 있습니다. 6.0.0 은 Electron 42~44 대상 표가 추가됐지만 Vite 8 대응 등 호환되지 않는 변경이 많아 이번 업그레이드와 묶지 않는 편이 안전합니다. | `node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:160-216`, https://github.com/alex8088/electron-vite/blob/master/CHANGELOG.md |
| `electron-builder` | 24.13.3 (최신은 26.18.0) | 확인하지 못했습니다. Electron 버전은 `node_modules/electron/package.json` 에서 읽고 배포용 zip 은 스스로 내려받으므로 구조상 걸리는 곳은 찾지 못했지만, 24 계열이 Electron 45 를 지원한다고 적은 문서는 없습니다. 실제 패키징으로 확인합니다. | `app-builder-lib/out/electron/electronVersion.js`, https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/CHANGELOG.md (`electron_wer.dll` 이름 바꾸기는 27.0.0-alpha.12 에만 있음) |
| `electron-updater` | 6.8.9 (최신 6.8.11) | 동작할 것으로 판단합니다. Electron API 는 `app`, `net`/`session` 일부만 쓰는 런타임 라이브러리입니다. Electron 버전 범위를 적은 문서는 없습니다. | `package.json` 에 `engines` 없음. 6장에서 실제 업데이트로 확인. |

## 6. 올린 뒤 직접 확인해야 하는 것

- **아크릴 창 (Windows 11 22H2 이상):** Glass + "창 뒤가 비치는" 설정으로 본창을 띄워 아크릴이 처음부터 그려지는지, 타이틀바 두 번 누르기·최대화 버튼의 작업 영역 채우기(`createFillToggle`)와 `hookWindowMessage(WM_PARENTNOTIFY)` 가 그대로 동작하는지, `setOpacity`(50~100%)가 아크릴 창과 일반 창에서 되는지 확인합니다. 그 뒤 `maximizable: false` 를 빼고 실제 최대화를 했을 때 재질이 유지되는지 따로 시험합니다.
- **로컬 터미널 (`node-pty`):** 개발 실행과 **패키징된 설치본** 양쪽에서 PowerShell 탭 열기, 분할(칸마다 셸), 크기 변경, 탭 닫기 뒤 프로세스가 남지 않는지 확인합니다. macOS 빌드에서는 `spawn-helper` 실행 권한과 임시 서명 순서(`scripts/mac-adhoc-sign.cjs`)가 그대로 맞는지 확인합니다.
- **Oracle:** thin 방식 접속(12.1 이상), Instant Client 설치 뒤 thick 방식 접속(11g), `NJS-138` 을 본 뒤 설치해서 다시 시작 없이 접속되는지(`loadCopy` 의 `require.cache` 지우기가 Node 24 에서도 통하는지), `localTunnel.js` 의 일회용 포트를 확인합니다.
- **`safeStorage`:** 28 에서 저장한 `auto-unlock.dat` 로 45 에서 자동 잠금 해제가 되는지, `remote-access.json` 의 `totpSecretSealed` 와 웹 푸시 서명 키가 풀리는지 확인합니다. 콘솔에 사용 중단 경고가 나오는 것은 정상입니다. 가능하면 `decryptStringAsync` 로도 예전 자료가 풀리는지 미리 시험해 둡니다.
- **자동 업데이트 (Windows):** 28 기반 현재 설치본 → 45 기반 새 버전으로 `electron-updater` 업데이트가 내려받아지고 `quitAndInstall(true, true)` 뒤 다시 실행되는지, 그리고 45 기반 → 45 기반 업데이트도 되는지 확인합니다. macOS 의 수동 업데이트 안내(`manualUpdate.js`)도 봅니다.
- **패키징된 설치본:** NSIS·포터블을 `electron-builder` 24.13.3 으로 만들어 실행합니다. exe 아이콘(`signAndEditExecutable`), 작업 표시줄 버튼 묶임(`setAppUserModelId`), `asarUnpack` 된 `node-pty`·`oracledb/build`, `build.files` 에서 뺀 `@azure` 없이 SQL Server 접속, `out/main/src/*` 로 복사된 모듈 로드를 확인합니다. macOS 는 CI(Node 올린 뒤)로 dmg·zip 을 만들어 Apple Silicon 에서 실행되는지 봅니다.
- **SSH 알고리즘:** 새 Electron 의 main 에서 `require('./src/sshAlgorithms.js').SSH_ALGORITHMS` 를 찍어 28 의 결과와 비교하고, 오래된 서버(SHA-1 키 교환, CBC, `ssh-dss`) 접속을 실제로 해 봅니다. `ssh2` 기본 알고리즘(curve25519, chacha20-poly1305, aes-gcm)과 호스트 키 지문 계산도 함께 봅니다.
- **PDF·이미지 미리보기:** 서버 파일 `미리보기` 로 PDF 가 iframe 안에 뜨는지(41 의 OOPIF 변경, CSP `frame-src blob:`, `navigationGuard`) 확인합니다.
- **파일 대화상자:** `defaultPath` 가 없는 대화상자가 다운로드 폴더에서 시작하는 것, 파일 이름만 넘긴 저장 대화상자가 어디에서 열리는지 확인합니다.
- **MCP 서버와 원격 접속:** `StreamableHTTPServerTransport`(Node 24 의 `http`), 확인 창의 "항상 위"·`showInactive()` 다시 그리기(`docs/brain/2026-10-26-electron-occluded-window-not-repainted-after-raise.md` 의 우회가 Chromium 156 에서도 필요한지), Windows 알림, 원격 접속의 HTTPS·WebSocket·웹 푸시(`createECDH('prime256v1')`, HKDF, AES-128-GCM)를 확인합니다. `npm test` 의 웹 푸시 표준 벡터 테스트는 시스템 Node 로 돌기 때문에 Electron 안의 암호 라이브러리는 검증하지 않습니다.
- **렌더러 화면:** Chromium 120 → 156 사이의 변화는 Electron 문서에 없으므로 눈으로 봅니다. xterm(캔버스 애드온) 글자 폭, Glass 의 `backdrop-filter`, `inert`, 끌어 놓기(탭·칸·SFTP), Radix 메뉴 위치, 테마 안내 상자, `webFrame` 확대/축소, `npm run e2e` 명세를 확인합니다.
- **빌드 절차:** 새로 `npm ci` 한 뒤 `npx install-electron --no` → `npm run dev`, `npm run build`, `npm run build:icon`, `npm run e2e` 가 되는지 확인합니다.

## 7. 확인하지 못한 것

- **임시(ad-hoc) 서명 앱의 macOS 알림.** 문서는 "code-signed" 여야 한다고만 적습니다. 임시 서명이 포함되는지는 https://github.com/electron/electron/pull/47817 의 논의나 실제 mac 빌드에서 `Notification` 의 `failed` 이벤트를 찍어 봐야 압니다.
- **Electron 45 의 암호 라이브러리가 지원하는 오래된 알고리즘.** Electron 문서에 항목이 없습니다. 새 Electron 에서 `crypto.getCiphers()`, `crypto.getHashes()`, `ssh2/lib/protocol/constants.js` 의 `SUPPORTED_*` 를 찍어 28 과 비교하면 확인됩니다.
- **`electron-builder` 24.13.3 이 Electron 45 를 문제없이 패키징하는지.** 지원 범위를 적은 공식 문서를 찾지 못했습니다. 실제 `npm run build:nsis`·`build:mac` 으로 확인합니다. 문제가 있으면 26.x 로 올리는 것을 따로 검토합니다 (24 → 26 의 변경 사항은 이번에 읽지 않았습니다).
- **`electron-vite build` 가 Electron 바이너리 없이 되는지.** 코드상 `getElectronPath()` 는 개발 실행·미리보기·바이트코드에서만 불리는 것으로 보이지만 끝까지 추적하지 않았습니다. CI 에서 `install-electron` 없이 `npm run build:mac` 을 돌려 보면 확인됩니다.
- **파일 이름만 넘긴 `defaultPath` 의 시작 폴더(43 이후).** 문서는 `defaultPath` 를 주지 않은 경우만 설명합니다. 실행해서 확인합니다.
- **아크릴 수정(#45456, #46657)이 이 앱의 증상을 실제로 없애는지,** 그리고 "실행 중 `setBackgroundMaterial('acrylic')` 이 그려지지 않는" 문제가 고쳐졌는지. 관련 PR 은 제목 검색으로 찾은 두 건뿐이며, 45 까지의 모든 릴리스 노트를 훑지는 않았습니다. https://github.com/electron/electron/releases 에서 `backgroundMaterial` 로 검색하면 더 확인할 수 있습니다.
- **Chromium 120 → 156 의 CSS·웹 API 변화.** Electron 의 breaking changes 문서에 적힌 것(WebSQL, `execCommand('paste')`, `unload`, iframe Permission Policy)만 확인했고, Chromium 쪽 릴리스 노트(https://chromestatus.com/release-notes/156 등 버전별)는 읽지 않았습니다.
- **Node 18 → 24 의 사용 중단·제거 항목 전체.** main 코드에서 `createCipher(`, `new Buffer(`, `url.parse(`, `process.binding` 같은 대표 항목은 검색해서 없음을 확인했지만, 의존성 안쪽과 Node 20·22·24 의 변경 목록 전체는 대조하지 않았습니다. 올린 뒤 `--trace-deprecation` 으로 실행해 경고를 모으면 확인됩니다.
- **`scripts/build-icon.cjs` 가 `capturePage`/`toBitmap` 변경(43·46)에 걸리는지.** 스크립트를 읽지 않았습니다. 올린 뒤 `npm run build:icon` 결과물을 지금 것과 비교하면 됩니다.
- **29~45 각 버전의 전체 릴리스 노트(버그 수정·동작 변화).** breaking changes 문서 전문과 버전별 블로그 글(29~44 는 주제어 검색, 45 는 전문)을 읽었고, GitHub 릴리스의 세부 수정 목록은 읽지 않았습니다.

## 출처

- Electron breaking changes: https://www.electronjs.org/docs/latest/breaking-changes (원본 https://raw.githubusercontent.com/electron/electron/main/docs/breaking-changes.md, 2026-11-17 내려받음, 29.0~47.0 절 전문)
- 릴리스 일정·지원 정책: https://www.electronjs.org/docs/latest/tutorial/electron-timelines, https://releases.electronjs.org/schedule, https://releases.electronjs.org/releases.json
- 버전별 릴리스 글: https://www.electronjs.org/blog/electron-29-0 ~ https://www.electronjs.org/blog/electron-45-0
- API 문서: https://www.electronjs.org/docs/latest/api/browser-window, https://www.electronjs.org/docs/latest/api/structures/base-window-options, https://www.electronjs.org/docs/latest/api/safe-storage
- 플랫폼 지원: https://github.com/electron/electron/blob/main/README.md
- Node 전역: https://github.com/nodejs/node/blob/v24.x/doc/api/globals.md
- npm 레지스트리(패키지별 최신 버전·`engines`): https://registry.npmjs.org/<패키지>
