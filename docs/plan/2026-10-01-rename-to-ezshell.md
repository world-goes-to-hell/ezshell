# 프로젝트 이름 변경: My SSH Client → ezShell

## 결정 (사용자, 2026-10-01)
- 제품명 `ezShell`, 저장소/패키지 이름 `ezshell`
- GitHub 저장소 이름도 변경 (gh)

## 원칙
- **저장된 데이터를 잃지 않는다.** Electron 의 사용자 데이터 폴더는 앱 이름을 따른다.
  - 설치/포터블과 `npm run dev` 모두 package.json `name` → `%APPDATA%\my-ssh-client`
    (처음에는 설치본이 `build.productName` 을 따른다고 가정했지만, 설치본 app.asar 의 package.json 에 productName 이 없어 name 을 따르는 것을 확인함.
    실제 데이터도 `%APPDATA%\My-ssh-client` 에만 있었다 — Windows 는 대소문자 무시)
  - 이름 변경 후 새 기본 폴더는 `%APPDATA%\ezshell`
  - 여기에 sessions.json, folders.json, settings.json, master.json, auto-unlock.dat, 테마(localStorage) 가 있다.
  - 이름을 바꾸면 빈 새 폴더를 쓰게 되어 세션이 "사라진" 것처럼 보인다 → 옛 폴더가 있으면 계속 그 폴더를 쓴다 (`src/userDataDir.js`, `app.setPath('userData')` 를 다른 코드보다 먼저)
- **`appId` 는 바꾸지 않는다** (`com.sungkwan.ssh-client`). 바꾸면 Windows 가 다른 앱으로 보고 설치형이 두 개 설치된다.
- 로컬 작업 폴더 이름(`my-ssh-client`)은 바꾸지 않는다 (작업 환경/메모리 경로가 이 이름에 묶여 있음, 필요하면 사용자가 직접)

## 작업
- [x] GitHub 저장소 이름 변경 `world-goes-to-hell/my-ssh-client` → `world-goes-to-hell/ezshell`, 로컬 origin 갱신
  - 옛 주소는 301 리다이렉트 (웹 `/releases/latest`, API 모두 확인) → 기존 설치본의 업데이트 확인이 새 저장소로 이어진다
- [x] `src/userDataDir.js` + 테스트 (옛 폴더 우선, 없으면 새 기본 폴더)
- [x] `main.js`: 시작 직후 `app.setPath('userData', ...)` (electron-updater require 보다 먼저), `electron.vite.config.ts` MAIN_RUNTIME_MODULES 에 추가
- [x] `package.json`: name `ezshell`, productName `ezShell`, shortcutName `ezShell`, portable artifactName `ezShell-${version}-portable.exe`, publish repo `ezshell`
- [x] 화면 문구: index.html title, TitleBar, LockScreen, WelcomeScreen
- [x] README, CLAUDE.md
- [x] 타입 체크, 테스트 300개, 빌드(out/main/src/userDataDir.js 복사 확인), dev 실행: 제목 ezShell, 기존 폴더의 세션 30개·폴더 목록 로드, 자동 잠금 해제 동작. 시작 시 빈 `%APPDATA%\ezshell` 폴더가 생기지만(Electron 이 메인 스크립트 전에 만듦) 비어 있고 옛 폴더가 항상 우선

## 배포 시 확인할 것 (다음 릴리스)
- 기존 v1.5.0 설치본이 자동 업데이트로 새 이름 버전을 받는지
- 설치형 업데이트 후 바로가기 이름이 ezShell 로 바뀌고 이전 바로가기가 남지 않는지
- 업데이트 후 세션/마스터 비밀번호/테마가 그대로인지

## 작업 중 사고 기록
- 설치본 설정을 보려고 `npx @electron/asar extract-file <app.asar> package.json` 을 프로젝트 폴더에서 실행해 **프로젝트 package.json 이 v1.4.0 설치본 파일로 덮어써졌다.**
  HEAD 의 package.json + package-lock.json 루트의 의존성(차이는 `xterm-addon-serialize` 하나) + 이름 변경 5곳으로 복구했고, lock 과 의존성 목록이 정확히 일치함을 확인했다.
  → asar 에서 파일을 꺼낼 때는 반드시 임시 폴더에서 실행한다.
