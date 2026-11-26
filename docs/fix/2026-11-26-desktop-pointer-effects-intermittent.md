# 다른 프로그램 위 포인터 효과가 됐다 안 됐다 하던 문제

## 증상

설정 > 테마 > 포인터 효과의 **다른 프로그램에서도 쓰기**를 켜면 앱 밖에서도 효과가 보이다가, 움직일 때 효과와 누를 때 효과가 모두 가끔 보이지 않았다 (2026-11-26 사용자 보고).

## 찾은 원인

0. **효과 창이 스스로 효과를 껐다 (주원인, 사용자 PC 에서 확인).** 효과는 Windows 알림 상태(`SHQueryUserNotificationState`)가 1~4 이면 멈춘다. Windows 는 모니터를 덮는 topmost 창이 있으면 "바쁨(전체 화면 앱, 2)"으로 보는데, 효과 창이 바로 그런 창이다. 효과 창이 뜨면 2 → 숨으면 5 → 다시 뜨면 2 를 도우미의 확인 간격(2초)마다 되풀이해, 바탕화면을 포함한 어디서나 2초 보이고 2초 사라졌다. 확인용 스크립트로 맨 앞 창이 그대로인 채 상태만 2초마다 5↔2 로 바뀌는 것을 봤다.

1. **잠금을 풀어도 다시 켜지지 않았다 (확인).** 잠글 때 main 이 `globalPointerEffects.stop()` 으로 효과 창을 닫는다. 화면(`lib/pointerDesktop.ts`)은 설정을 처음 잠금을 풀 때 한 번, 그 뒤로는 값이 바뀔 때만 보낸다(`unlockedOnce`, 같은 값이면 보내지 않음). 그래서 잠금을 푼 뒤에는 설정을 건드리거나 앱을 다시 켤 때까지 꺼져 있었다.
2. **다른 "항상 위" 창 아래로 깔렸다 (Windows 동작).** 효과 창은 `setAlwaysOnTop(true, 'screen-saver')` 인 투명 창이다. Windows 는 나중에 앞으로 나온 topmost 창(클릭한 작업 표시줄, 다른 앱의 항상 위 창)을 그 위에 둔다. 효과 창은 포커스를 받지 않으므로 스스로 다시 올라오지 않는다. Electron 은 단계가 바뀔 때만 `HWND_TOPMOST` 를 다시 걸어, 같은 값을 다시 불러도 소용없다.
3. **가려졌다고 보고 그리기를 멈출 수 있었다.** 효과 창은 `requestAnimationFrame` 으로 그리고, `document.hidden` 이 되면 효과를 지운다. 투명하고 클릭이 통과하는 topmost 창을 Chromium 이 가려졌다고 판단하면 프레임이 멈춘다.

2·3번은 사용자 PC 에서 재현하지 못한 보강이다.

## 고친 것

- `src/globalPointer.js` 의 도우미: Windows 의 추측(2)은 버리고, 맨 앞 창이 모니터 전체를 덮는지 직접 본다(`ForegroundFullScreen`). 바탕화면(`Progman`·`WorkerW`), 작업 표시줄, 이 앱의 창, 제목 줄이 있는 최대화 창은 전체 화면으로 치지 않는다. 효과 창은 포커스를 받지 않아 맨 앞 창이 되지 않으므로 순환이 생기지 않는다. 잠금(1)·D3D 전체 화면(3)·프레젠테이션(4)은 그대로 멈춘다. 확인 간격은 1초. 규칙은 순수 함수(`Adjust`, `FullScreenWindow`)로 두고 컴파일해 시험한다.
- `src/globalPointerEffects.js`: `suspend()`(잠금: 효과를 멈추고 설정은 기억), `resume()`(잠금 해제: 같은 설정으로 다시 켬). `stop()` 은 설정도 잊는다(창이 닫힐 때, 앱 종료). `main.js` 의 잠금 두 곳은 `suspend()`, 잠금 해제 두 곳은 `resume()` 을 부른다.
- 같은 파일: 효과 창을 `setAlwaysOnTop(false)` → `setAlwaysOnTop(true, 'screen-saver')` 로 topmost 맨 위에 다시 올린다. 누를 때마다, 포인터가 움직이는 동안 1초에 한 번, 일시 멈춤(전체 화면 앱·잠금 화면)에서 다시 보일 때.
- 같은 파일: 효과 창의 `webPreferences.backgroundThrottling: false` 로 가려짐 판단 때문에 프레임이 멈추지 않게 했다.

## 남은 것

- Windows 가상 데스크톱을 바꾸면 효과 창은 처음 만든 데스크톱에 남는다(Electron 은 Windows 에서 모든 데스크톱에 보이게 하는 API 가 없다).
- 한 모니터의 맨 앞 창이 전체 화면이면 모든 모니터의 효과가 멈춘다 (전체 화면 영상 위에 그리지 않으려는 의도).
- 위 고친 것 뒤에도 끊기면, 끊길 때의 상황(어느 프로그램 위, 잠금 직후인지, 전체 화면 영상)을 보고 다시 본다.

## 확인

`npx vitest run src/globalPointerEffects.test.js` (잠금 후 같은 설정으로 복원, 꺼 두었거나 창이 닫힌 뒤에는 복원하지 않음, 누를 때·움직이는 동안 1초에 한 번·일시 멈춤 뒤 다시 올림, `backgroundThrottling: false`), `npm run e2e -- pointer-themes`.
