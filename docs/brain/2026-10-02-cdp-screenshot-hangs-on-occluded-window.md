# 테스트 Electron 창이 다른 창에 가려지면 CDP 캡처가 멈춘다 (Windows)

## 증상
- `Page.captureScreenshot` 이 응답 없이 멈춘다. 같은 스크립트가 몇 분 전에는 잘 됐다.
- DOM 조회, 클릭, `Runtime.evaluate` 는 정상이라 스크립트 문제처럼 보인다.
- `document.visibilityState` 가 `hidden` 이다.

## 원인
- Windows 의 Chromium 은 창이 다른 창에 완전히 가려지면(native window occlusion) 숨김으로 보고 그리기를 멈춘다. 캡처는 새 프레임을 기다리므로 끝나지 않는다.
- 사용자가 작업하면서 테스트 창 위로 다른 창을 올리면 언제든 생긴다. `Page.bringToFront`, 앱의 최대화(`maximizeWindow`)로는 풀리지 않았다.

## 해결
- 테스트 앱을 띄울 때 다음 옵션을 붙인다.

      npx electron-vite dev -- --remote-debugging-port=9444 --user-data-dir=<scratchpad>/ud \
        --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding

- 캡처는 `Promise.race` 로 시간 제한을 두어, 멈췄을 때 스크립트 전체가 걸리지 않게 한다.

## 함께 겪은 것
- 시드 세션(`setup.mjs` 의 `addSession`)은 저장되지 않아서 앱을 다시 띄우면 사라진다. 재실행 후에는 시드를 다시 넣는다.

## 사례
- 2026-10-02 라이트 테마 6개 추가 후 테마별 화면 캡처 중 발생.
