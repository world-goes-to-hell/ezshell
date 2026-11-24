# 영역 캡처: Esc 로 닫으면 오류 알림, 끈 영역이 가끔 버려짐

작성: 2026-11-24 (여러 장 이어 찍기 작업 중 화면 테스트로 찾음, `docs/plan/2026-11-24-capture-multiple-shots.md`)

## 1. Esc 로 닫을 때마다 "화면을 캡처하지 못했습니다"

### 증상
화면 테스트의 고정 앱이 캡처 오류를 파일에 남기게 하자, Esc 로 덮개를 닫은 횟수만큼 `Render frame was disposed before the request completed` 가 기록됐다. 실제 앱에서는 이 오류가 `onError` 로 가서 Windows 알림 "ezShell 영역 캡처 · 화면을 캡처하지 못했습니다" 가 뜬다.

### 원인
덮개 페이지는 Esc·취소에서 `window.close()` 로 스스로 닫았다. main 은 그동안 `executeJavaScript('window.pickCaptureRegion(...)')` 의 답을 기다리고 있었는데, 창이 사라지면서 이 요청이 실패한다. 실패가 BrowserWindow 의 `close` 이벤트보다 먼저 오므로, `close` 에서 "사용자가 닫음" 표시를 세우고 catch 에서 보는 방식으로는 막지 못했다 (처음 고친 방법. 단위 테스트는 순서를 반대로 가정해 통과했고, 화면 테스트에서 여전히 5건이 남아 알았다).

### 수정
main 이 페이지의 답을 기다리는 중이면(`accept` 가 있으면) 페이지가 `{ action: 'close' }` 로 답하고, main 이 창을 닫는다 (`task.userClosed` 를 세워 묶음도 지운다). 기다리는 답이 없을 때(프로젝트 조회·전송 중)만 예전처럼 `window.close()`. 이 순서에는 실패할 요청이 남지 않는다. `close` 이벤트의 표시와 catch 의 확인은 Alt+F4 같은 다른 닫기를 위해 그대로 둔다.

### 시험
`quickCapture.test.js` 의 "closes without an error when the overlay answers that the user closed it". 화면 테스트 `quick-capture` 끝의 "no capture reported an error, closed ones included" (명세 전체에서 오류 0건).

## 2. 끈 영역이 가끔 선택되지 않음

### 증상
화면 테스트에서 다섯 번에 두 번 꼴로 "region was not selected". 상자는 그려졌는데 편집 패널이 뜨지 않았다.

### 원인
이벤트 순서를 찍어 보니 `pointerdown → gotpointercapture → lostpointercapture → pointerup` 이었다. Chromium 이 같은 끌기의 `pointerup` 바로 앞(1ms)에 붙잡기 해제를 알렸고, 덮개는 `lostpointercapture` 에서 끌기를 바로 취소해 뒤따른 `pointerup` 을 버렸다. 이 처리는 원래 있던 코드다. 실제 사용자에게도 "끌었는데 선택이 안 됨" 으로 가끔 나타날 수 있다.

### 수정
`lostpointercapture` 를 받으면 100ms 기다렸다가, 그 사이 같은 끌기가 `pointerup` 으로 끝나지 않았을 때만 취소한다. 그 사이 새 끌기가 시작됐으면 취소하지 않는다 (끌기 번호 `drags`: 마우스의 pointerId 는 늘 같아서 id 로는 구분할 수 없다).

### 시험
고친 뒤 `quick-capture` 화면 테스트를 세 번 연달아 돌려 49개 모두 통과. 실패하면 `selectRegion` 이 그 끌기의 포인터 이벤트 순서를 함께 보여 준다.
