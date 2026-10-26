# 가려져 있던 Electron 창을 포커스 없이 올리면 화면이 갱신되지 않는다 (Windows)

## 증상
다른 창 뒤에 있던 창을 `setAlwaysOnTop(true)` + `moveTop()` 으로 맨 위에 올리면 창은 보이지만, 가려져 있는 동안 바뀐 내용(새 대화상자 등)이 그려지지 않는다. 사용자가 창을 누르면 그제야 보인다.

## 왜 알아차리기 어려웠나
- 창은 분명히 맨 위로 온다. 그래서 "올리는 코드는 잘 된다" 고 보고 렌더러(React, Radix Dialog) 쪽을 의심하기 쉽다.
- 최소화된 창으로만 시험하면 재현되지 않는다. 최소화 경우에는 `showInactive()` 를 이미 불러서 상태가 풀렸다.
- 같은 Electron 창으로 덮어서 시험하면 가끔(첫 실행 등) 통과한다. 여러 번 돌려야 매번 실패하는 것이 보인다.

## 원인
Chromium 의 Windows 가려짐 계산(`CalculateNativeWinOcclusion`)이 창을 `hidden` 으로 두고 프레임을 만들지 않는다. 포커스 없이 z 순서만 바꾸는 호출로는 다시 계산되지 않는다.

## 판별
렌더러에서 `document.visibilityState` 와 `requestAnimationFrame` 실행 여부를 본다. 올린 뒤에도 `hidden` 이고 rAF 가 돌지 않으면 이 문제다. `webContents.invalidate()` 로는 풀리지 않는다.

## 해결
포커스 없이 보여야 하면 `win.showInactive()` 를 부른다 (이미 보이는 창에도). 크기·최대화 상태는 바뀌지 않는다.
`focus()`, `backgroundThrottling: false`, `--disable-features=CalculateNativeWinOcclusion`, hide 후 show 도 풀리지만 각각 포커스 빼앗기, 전력 사용, 깜빡임이 따른다.

## 사례
2026-10-26 ezShell 2.7.1, MCP 확인 요청 때 창은 올라오는데 확인 창이 안 보임. 상세: `docs/fix/2026-10-26-mcp-approval-raised-window-not-painted.md`
