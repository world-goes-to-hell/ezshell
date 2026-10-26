# MCP 확인 요청 때 창은 맨 위로 오는데 확인 창이 보이지 않음

- 날짜: 2026-10-26

## 증상
MCP 확인 요청이 오면 앱 창이 맨 위로 올라오지만 확인 창이 보이지 않았다. 작업표시줄에서 앱을 한 번 누르면 그제야 확인 창이 보였다.

## 원인
Windows 에서 Chromium 은 다른 창에 완전히 가려진 창을 "가려짐(native occlusion)" 으로 보고 `document.visibilityState` 를 `hidden` 으로 바꾸며 화면을 새로 그리지 않는다.
2.5.1 의 `keepMainWindowOnTop` 은 최소화된 경우에만 `showInactive()` 를 부르고, 가려진 창에는 `setAlwaysOnTop(true)` + `moveTop()` 만 했다. 이것만으로는 가려짐 상태가 풀리지 않아, 창은 위로 왔지만 확인 창이 없던 예전 화면이 그대로 남았다. 창을 누르면(활성화) 상태가 다시 계산되어 보였다.

Electron 28 로 재현했다 (다른 창으로 덮은 뒤 내용 변경 → 현재 방식으로 올림 → 1.2초 뒤 `visibilityState`, `requestAnimationFrame` 실행 여부 확인).
- 현재 방식: 6번 중 6번 `hidden`, rAF 안 돎
- `showInactive()` 항상 호출: 3번 중 3번 `visible`, 포커스 없음, 최대화 창은 최대화 유지
- 다른 후보(`backgroundThrottling: false`, `CalculateNativeWinOcclusion` 끄기, hide 후 show, `focus()`)도 보였지만 아래 이유로 고르지 않았다.
- `webContents.invalidate()` 는 효과가 없었다.

## 수정
`keepMainWindowOnTop(true)` 에서 최소화 여부와 상관없이 항상 `showInactive()` 를 부른다.

## 왜 이렇게 했나
- `focus()` 는 다른 프로그램에 입력하던 Enter·Esc 가 확인 창의 응답이 되므로 안 된다 (2.5.1 설계 결정).
- `backgroundThrottling: false` 와 가려짐 계산 끄기는 앱 전체(모든 창)가 가려져 있어도 계속 그리게 되어 전력을 더 쓴다. 이 문제 하나를 위해 바꿀 이유가 없다.
- hide 후 show 는 창이 깜빡인다.
- `showInactive()` 는 포커스를 가져오지 않고, 이미 보이는 창에 불러도 크기와 최대화 상태를 바꾸지 않았다.

관련 기억: `docs/brain/2026-10-26-electron-occluded-window-not-repainted-after-raise.md`
