# CDP 로 보낸 키는 before-input-event 에 닿지 않는다

## 겪은 일

브라우저 탭의 페이지(`WebContentsView`)에서 `F12` 를 누르면 개발자 도구가 열리도록 main 에 `before-input-event` 처리기를 달았다 (`src/ipc/browserReview.js`). 화면 테스트에서 페이지의 CDP 대상에 `Input.dispatchKeyEvent`(`rawKeyDown`, `keyDown` 둘 다, 페이지를 먼저 눌러 포커스를 준 뒤에도)로 `F12` 를 보냈는데 처리기가 한 번도 불리지 않았다.

## 확인

맨 Electron 스크립트(창 하나, `WebContentsView` 하나, 처리기가 본 키를 기록)로 비교했다.

- `webContents.debugger.sendCommand('Input.dispatchKeyEvent', …)`: 처리기에 아무것도 오지 않음
- `webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F12' })`: `keyDown:F12`, `keyUp:F12` 가 옴

`sendInputEvent` 는 실제 키보드 입력과 같은 경로라, 처리기 코드는 맞고 시험 방식이 닿지 않는 것이다.

## 적용

- `before-input-event` 로 처리하는 키(앱 창 단축키 포함)는 CDP 로 키를 보내는 화면 테스트로 확인할 수 없다. 시험이 실패해도 처리기를 의심하기 전에 이 점을 먼저 떠올린다.
- 확인이 필요하면 맨 Electron 스크립트에서 `sendInputEvent` 로 본다. 화면 테스트에는 같은 동작을 하는 버튼·IPC 경로를 확인하고, 키는 빼고 이유를 주석으로 남긴다 (`e2e/specs/browser-tab-title.js`).
