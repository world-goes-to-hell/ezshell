# 앱 식별자와 아이콘

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

## App Name and User Data Folder

앱 이름은 `ezShell` (이전 이름 `My SSH Client`). Electron 사용자 데이터 폴더는 앱 이름을 따르므로,
`main.js` 시작 부분에서 `src/userDataDir.js` 로 옛 폴더(`%APPDATA%\my-ssh-client`)가 있으면 그 폴더를 계속 쓴다.
폴더 이름은 `build.productName` 이 아니라 package.json `name` 을 따른다 (패키징된 package.json 에 productName 이 없음). 설치본과 dev 가 같은 폴더를 쓴다.
`appId`(`com.sungkwan.ssh-client`)는 바꾸지 않는다. 바꾸면 설치형이 다른 앱으로 인식된다.
`main.js` 시작 부분이 설치본에서 `app.setAppUserModelId` 로 같은 값을 정한다 (`WINDOWS_APP_USER_MODEL_ID`, 바로가기의 ID 와 같아야 모든 창이 작업 표시줄 버튼 하나로 묶인다. 없으면 실시간 보기 창이 버튼을 하나 더 만들었다: `docs/fix/2026-11-13-taskbar-second-button.md`).

## App Icon

원본은 `assets/icon.svg`, `npm run build:icon` 으로 icon.ico/icon.png/icon.icns 를 만든다 (`scripts/build-icon.cjs`, ICO 작성은 `scripts/ico.cjs`, ICNS 는 `scripts/icns.cjs`).
exe 아이콘은 `build.win.signAndEditExecutable: true` 일 때만 들어간다 (false 면 Electron 기본 아이콘).
창/작업표시줄 아이콘은 빌드 때 `out/main/icon.ico` 로 복사되고 모든 BrowserWindow 의 `icon` 으로 지정된다.
타이틀바 왼쪽 아이콘은 같은 명령이 만드는 `src/renderer/assets/app-icon.svg`(작은 크기용, 직접 수정 금지)를 `?no-inline` 으로 불러온다.
작은 SVG 가 data: URL 로 인라인되면 페이지 CSP(`default-src 'self'`)에 막히기 때문이다.
macOS 용 `icon.icns` 는 mac 도구(iconutil) 없이 Windows 에서 PNG(32~1024px)를 ICNS 컨테이너로 직접 포장해 만든다 (`scripts/icns.cjs`, `ico.cjs` 와 같은 방식). 저장소에 커밋해 두어 CI 가 바로 쓴다.
