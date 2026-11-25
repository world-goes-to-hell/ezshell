# 마우스 포인터 모양·효과를 다른 프로그램에서도

작성: 2026-11-25 (사용자 요청: "쉘 밖에서도 적용되게 할 수 있으면 설정에서 옵션 만들어서")

상태: 1·2단계 구현. 2단계의 실제 Windows 화면 확인은 남아 있음.

## 범위
- Windows 만. macOS 는 시스템 포인터를 바꾸는 공개 API 가 없고, 전역 입력에 손으로 허락하는 권한이 필요하다.
- 설정 > 테마 > 마우스 포인터에 두 칸을 더한다. 둘 다 기본 꺼짐이다.
  - `다른 프로그램에서도 포인터 모양 쓰기`
  - `다른 프로그램에서도 효과 쓰기`
- 세트·크기·효과·세기는 앱 안의 설정을 그대로 쓴다. 따로 고르지 않는다.

## 1단계: 포인터 모양
- 화면이 지금 세트의 그림을 PNG 로 그려 main 에 보낸다. main 은 형식(PNG, 크기 32·48·64, 상태 이름)을 검사한다.
- 새 도우미(`src/globalPointer.js`, Windows PowerShell + C#)가 `CreateIconIndirect` 로 포인터를 만들고 `SetSystemCursor` 로 시스템 포인터를 바꾼다.
- 상태 대응: default→`OCR_NORMAL`, pointer→`OCR_HAND`, text→`OCR_IBEAM`, wait→`OCR_WAIT`, progress→`OCR_APPSTARTING`, not-allowed→`OCR_NO`, col-resize→`OCR_SIZEWE`, row-resize→`OCR_SIZENS`, crosshair→`OCR_CROSS`. grab·grabbing 은 시스템에 대응하는 포인터가 없어 뺀다.
- 되돌리기: `SystemParametersInfo(SPI_SETCURSORS)`. 사용자의 포인터 구성표(레지스트리)는 건드리지 않는다.
  - 옵션을 끌 때, 세트를 `시스템 기본` 으로 바꿀 때, 앱이 끝날 때 되돌린다.
  - 바꿀 때 `userData` 에 표시 파일을 남긴다. 도우미가 재시작하면 이 표시로 복원이 필요한지 판단한다. 앱을 닫을 때는 표시를 지우기 전에 도우미에 복원 명령을 보낸다. 도우미가 없으면 표시를 남겨 다음 앱 시작에서 복원한다.

## 2단계: 효과
- 모니터마다 투명한 창을 하나씩 띄운다. 클릭이 통과하고(`setIgnoreMouseEvents(true)`), 포커스를 받지 않고, 맨 위에 있다. 다른 배율의 모니터에서도 맞게 덮도록 로드가 끝나면 창 크기와 위치를 다시 맞추고, 결과가 모니터의 범위와 다르면 로그에 기록한다.
- `setContentProtection(true)` 로 화면 캡처·화면 공유에 찍히지 않게 한다 (ezShell 의 영역 캡처 포함).
- 그리기는 `lib/pointerEffects.ts` 를 그대로 쓰는 가벼운 페이지다 (React 앱을 띄우지 않는다).
- 포인터 위치는 main 이 `screen.getCursorScreenPoint()` 로 읽고, 누름은 도우미가 `GetAsyncKeyState` 로 본다.
  - 바꾸면 안 되는 것: 저수준 마우스 후크(`WH_MOUSE_LL`)를 쓰지 않는다. 후크의 처리가 늦으면 시스템 전체의 마우스가 끊긴다 (도우미가 stdout 쓰기에서 막히는 순간).
  - 움직임 효과가 있을 때 위치를 약 16ms마다 읽고, 포인터가 멈추면 간격을 80ms로 늘린다. 누름 효과만 있으면 클릭할 때만 위치를 읽는다.
- 포인터가 포커스를 가진 ezShell 창에 들어오면 바깥 위치 강조를 숨긴다. 이미 그린 입자는 수명이 끝날 때까지 남는다. 앱 안의 효과가 `터미널 위에서` 설정까지 적용한다. 바깥 효과 창은 이 판정에서 제외한다.
- Windows 잠금·화면 보호기·사용자 전환 및 전체 화면 게임·발표 중(`SHQueryUserNotificationState` 의 1~4 상태)에는 효과 창과 위치 폴링을 멈춘다.
- 동작 줄이기 설정은 앱 안과 같은 규칙을 따른다.

### 알려진 한계

- ezShell에 포커스를 주는 첫 클릭에서 포커스 전환·누름 감시 순서에 따라 안팎의 물결이 둘 다 나타날 수 있다.
- 포커스된 ezShell의 브라우저 탭 영역과 다른 프로그램의 항상 위 창이 겹치면 바깥 효과가 표시되지 않을 수 있다.
- 개발 실행에서는 `pointer-effects.html`의 CSP가 Vite HMR 연결을 막아 콘솔에 오류가 뜰 수 있다. 빌드에는 HMR이 포함되지 않는다.
- Windows 10 2004 이전에는 `setContentProtection`이 `WDA_MONITOR`처럼 동작해 화면 공유에 효과 창이 검은 판으로 나타날 수 있다. [Electron 캡처 보호](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows)

## 도우미를 따로 두는 이유
작업 개요 단축키의 도우미(`globalDoubleTab.js`)는 PowerShell 명령줄 길이(32,767자) 때문에 스크립트가 2만 8천 자 이하여야 하고 지금 약 2만 4천 자다. 키보드 후크와 같은 프로세스에 두면 한쪽 실패가 다른 쪽을 멈춘다.

## 시험
- 단위: 상태 대응, PNG 검사, 표시 파일로 되돌리는 순서, 효과 창의 ezShell 창 판정.
- 도우미 C# 컴파일 시험 (기존 도우미와 같은 방식).
- 화면 시험 `pointer-themes` 에서는 main 이 설정을 받는 것까지 확인한다. `allowNative: false` 로 시스템 포인터 교체, 도우미 실행과 효과 창 생성을 막는다.

## 진행
- [x] 1단계 시험 구현: 48·64px 포인터가 `SetSystemCursor` 로 그 크기 그대로 보이는지 확인. 사용자 PC 에서 32·48·64px 모두 그대로 보였다 (PNG 를 담은 `.cur` 를 `LoadImage` 로 읽음)
- [x] 1단계: `src/globalPointer.js`, `lib/pointerSystem.ts`, 설정의 `다른 프로그램에서도 쓰기`. 비정상 종료 대비는 표시 파일만이 아니라 도우미가 입력 끝(앱의 파이프가 닫힘)에서 되돌리는 것으로 했다
- [x] 2단계: 포인터 효과 탭에 Windows 전용 토글을 두고 모니터별 효과 창을 연결했다. 실제 PC 에서 모니터·배율 전환, 전체 화면·발표 모드, 클릭 통과와 캡처 제외를 확인할 항목으로 남겼다.
