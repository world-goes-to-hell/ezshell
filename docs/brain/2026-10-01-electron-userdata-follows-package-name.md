# Electron 사용자 데이터 폴더는 build.productName 이 아니라 package.json name 을 따른다

## 상황
앱 이름을 My SSH Client → ezShell 로 바꾸면서, 저장된 세션이 있는 폴더를 지키려 했다.
처음에는 "설치본은 `build.productName`(My SSH Client), dev 는 `name`(my-ssh-client) 폴더를 쓴다" 고 가정했는데 틀렸다.

## 사실
- electron-builder 가 app.asar 에 넣는 package.json 에는 최상위 `productName` 이 없다 (`build.productName` 은 설치 파일/바로가기 이름에만 쓰임).
- Electron 의 `app.getName()` 은 package.json 의 `productName || name` 이므로, 설치본도 dev 도 `name` 을 따른다.
- 그래서 실제 데이터는 `%APPDATA%\my-ssh-client` 하나에만 있었다 (탐색기에는 `My-ssh-client` 로 보였지만 Windows 는 대소문자 무시).
- `package.json` 의 `name` 을 바꾸면 이 폴더가 바뀐다 → 세션/마스터 비밀번호/테마가 사라진 것처럼 보인다.
- `app.setPath('userData', ...)` 를 해도 Electron 이 시작 시 기본 폴더(`%APPDATA%\ezshell`)를 빈 채로 만든다. 그래서 "새 폴더가 있으면 새 폴더" 순서로 고르면 안 되고, 옛 폴더가 있으면 항상 옛 폴더를 쓴다.

## 확인 방법
- 가정하지 말고 `%APPDATA%` 아래 실제 폴더와 그 안의 sessions.json / master.json 을 본다.
- 설치본 설정을 볼 때 app.asar 에서 package.json 을 꺼내야 한다면 **임시 폴더에서** 꺼낸다.
  `npx @electron/asar extract-file <app.asar> package.json` 은 현재 폴더에 같은 이름으로 풀어서, 프로젝트 폴더에서 실행하면 프로젝트 package.json 을 덮어쓴다 (실제로 겪음, HEAD + package-lock 으로 복구).
- 세션 로드 확인은 개수만 센다. `loadSessions()` 결과를 그대로 출력하면 복호화된 접속 정보가 로그에 남는다.

## 사례
2026-10-01 ezShell 이름 변경. 상세: docs/plan/2026-10-01-rename-to-ezshell.md
