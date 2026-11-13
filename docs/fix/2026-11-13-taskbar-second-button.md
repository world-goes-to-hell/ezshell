# 실시간 보기 창이 작업 표시줄에 ezShell 버튼을 하나 더 만듦

- 날짜: 2026-11-13

## 증상
설치본에서 실시간 보기(파일 창)를 열면 작업 표시줄에 ezShell 버튼이 두 개 보였다. 같은 프로그램의 창이면 한 버튼에 묶여야 한다.

## 원인
Windows 는 작업 표시줄 버튼을 AppUserModelID(AUMID) 로 묶는다. 실제로 읽어 본 값:
- 설치본이 만든 바로가기(작업 표시줄 고정, 시작 메뉴): `com.sungkwan.ssh-client` (`build.appId`)
- 앱의 모든 창(본창, `cms.log - ezShell`): 창 AUMID 없음 (`SHGetPropertyStoreForWindow` → 미설정)

앱이 `app.setAppUserModelId` 를 부르지 않아 창들의 ID 가 바로가기와 같다는 보장이 없었다. Electron 은 ID 가 정해지지 않으면 자기 기본값(`electron.app.<이름>`)을 쓸 수 있고, 그 뒤에 만든 창은 고정 바로가기와 다른 버튼으로 묶인다.

조사 중 같이 확인한 것: dev 앱(`node_modules\electron\dist\electron.exe`)이 함께 실행 중이면 실행 파일이 달라서 같은 아이콘의 버튼이 하나 더 생긴다. 이것은 정상이다.

## 수정
`main.js` 시작 부분에서 Windows 설치본(`app.isPackaged`)일 때 `app.setAppUserModelId('com.sungkwan.ssh-client')` 를 부른다. 바로가기와 같은 ID 라서 모든 창이 고정 아이콘 한 버튼에 묶이고, 알림도 같은 앱 이름으로 나온다.

dev 실행에는 걸지 않는다: 걸면 dev 창이 설치본의 고정 버튼에 섞인다.

## 바꾸면 안 되는 것
이 값은 `package.json` 의 `build.appId` 와 같아야 한다. `appId` 는 원래 바꾸지 않는다 (설치형이 다른 앱으로 인식된다).

## 확인
다음 설치본(업데이트)에서 실시간 보기를 열어 버튼이 하나인지 본다. dev 에서는 확인할 수 없다.
