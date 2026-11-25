# Windows 세션 종료와 Electron의 종료 이벤트

Electron의 `App` 타입 설명(`node_modules/electron/electron.d.ts`)은 Windows가 시스템 종료·재시작·로그오프로 앱을 닫을 때 `before-quit`가 오지 않는다고 명시한다. `BrowserWindow`는 Windows에서 `query-session-end`와 `session-end`를 제공한다. 세션 종료 자체를 막지 않고, 이미 main에 있는 기록으로 저장을 마친다.

`taskkill /F`나 전원 차단은 창이 렌더러에 데이터를 요청하고 답을 받을 시간을 보장하지 않는다. 재시작에 필요한 상태는 사용 중에 암호화해 디스크에 기록한다. 현재 실행의 복구 기록과 지난 실행의 복원 제안을 구분해야 화면 새로고침이 같은 탭을 또 열지 않는다.

이 사례는 `src/ipc/restoreTabs.js`에서 처리한다. 테스트는 Windows 종료 이벤트를 발행해 동기 저장을 확인하고, 별도 Electron 프로세스를 강제 종료한 뒤 같은 임시 프로필로 다시 시작한다.
