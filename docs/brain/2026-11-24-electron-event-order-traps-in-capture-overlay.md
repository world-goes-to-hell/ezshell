# 영역 캡처 덮개에서 겪은 이벤트 순서 함정 두 가지

작성: 2026-11-24. 바로 해결되지 않았던 이유: 둘 다 "당연히 이 순서일 것" 이라고 가정한 부분이었다. 단위 테스트는 그 가정을 그대로 흉내 내서 통과했다.

## 1. 페이지가 `window.close()` 하면, 기다리던 `executeJavaScript` 가 `close` 이벤트보다 먼저 실패한다
- 증상: main 이 `await win.webContents.executeJavaScript(...)` 로 페이지의 답을 기다리는 중에 페이지가 스스로 닫으면, 그 요청이 `Render frame was disposed before the request completed` 로 실패한다. 이 실패가 BrowserWindow `close` 이벤트보다 먼저 온다.
- 함정: `close` 에서 플래그를 세우고 catch 에서 보는 방식은 동작하지 않는다. 가짜 창으로 만든 단위 테스트는 `close` 를 먼저 내도록 짜서 통과했다.
- 해결: 페이지가 기다리는 답으로 "닫기" 를 돌려주고 main 이 창을 닫는다. 페이지가 직접 닫는 경로는 main 이 답을 기다리지 않을 때만 남긴다.
- 알아낸 방법: 화면 테스트의 고정 앱이 `onError` 를 파일에 이어 적게 하고, 명세 끝에서 그 파일이 비어 있는지 봤다 (앱 출력은 실행기가 버린다).

## 2. Chromium 이 `lostpointercapture` 를 같은 끌기의 `pointerup` 보다 먼저 보낼 때가 있다
- 증상: `setPointerCapture` 로 끌기를 하는 화면에서, CDP 로 보낸 끌기의 이벤트가 `pointerdown → gotpointercapture → lostpointercapture → pointerup` 순서로 왔다 (다섯 번에 두 번 꼴).
- 함정: `lostpointercapture` 에서 끌기를 바로 취소하면 1ms 뒤의 `pointerup` 이 버려진다. 실패가 간헐적이라 처음에는 화면 테스트의 흔들림으로 보였다.
- 해결: 해제 알림 뒤 잠깐(100ms) 기다렸다가, 같은 끌기가 끝나지 않았을 때만 취소한다. 마우스의 pointerId 는 늘 같으므로 끌기 번호로 구분한다.
- 알아낸 방법: 실패할 때 그 끌기의 포인터 이벤트 순서를 함께 찍게 했다 (`e2e/specs/quick-capture.js` 의 `selectRegion`).

## 같이 기억할 것
- 덮개·띠처럼 창을 닫는 클릭을 CDP 로 보낼 때는 `mouseReleased` 의 응답을 기다리지 말 것. 창이 먼저 사라지면 응답이 오지 않아 명세가 멈춘다 (`clickClosing`).
- Electron main 의 `ClipboardItem` 은 `getType()` 으로만 내용을 꺼낸다 (`contents` 같은 속성이 없다).
