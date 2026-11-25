# 마우스 포인터 모양·효과를 다른 프로그램에서도

작성: 2026-11-25 (사용자 요청: "쉘 밖에서도 적용되게 할 수 있으면 설정에서 옵션 만들어서")

상태: 1단계 끝 (2026-11-25), 2단계(효과) 남음

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
  - 앱이 비정상 종료되면 바꾼 포인터가 남는다. 바꿀 때 `userData` 에 표시 파일을 남기고, 다음 시작 때 표시가 있으면 먼저 되돌린다.

## 2단계: 효과
- 모니터마다 투명한 창을 하나씩 띄운다. 클릭이 통과하고(`setIgnoreMouseEvents(true)`), 포커스를 받지 않고, 맨 위에 있다.
- `setContentProtection(true)` 로 화면 캡처·화면 공유에 찍히지 않게 한다 (ezShell 의 영역 캡처 포함).
- 그리기는 `lib/pointerEffects.ts` 를 그대로 쓰는 가벼운 페이지다 (React 앱을 띄우지 않는다).
- 포인터 위치는 main 이 `screen.getCursorScreenPoint()` 로 읽고, 누름은 도우미가 `GetAsyncKeyState` 로 본다.
  - 바꾸면 안 되는 것: 저수준 마우스 후크(`WH_MOUSE_LL`)를 쓰지 않는다. 후크의 처리가 늦으면 시스템 전체의 마우스가 끊긴다 (도우미가 stdout 쓰기에서 막히는 순간).
  - 효과가 켜져 있을 때만 읽고(초당 60번), 포인터가 멈추면 간격을 늘린다.
- 포인터가 ezShell 창 위에 있으면 바깥 효과는 그리지 않는다. 앱 안의 효과가 `터미널 위에서` 설정까지 지켜 그린다.
- 전체 화면 게임·발표 중(`SHQueryUserNotificationState` 가 busy·D3D 전체 화면·발표 모드)에는 멈춘다.
- 동작 줄이기 설정은 앱 안과 같은 규칙을 따른다.

## 도우미를 따로 두는 이유
작업 개요 단축키의 도우미(`globalDoubleTab.js`)는 PowerShell 명령줄 길이(32,767자) 때문에 스크립트가 2만 8천 자 이하여야 하고 지금 약 2만 4천 자다. 키보드 후크와 같은 프로세스에 두면 한쪽 실패가 다른 쪽을 멈춘다.

## 시험
- 단위: 상태 대응, PNG 검사, 표시 파일로 되돌리는 순서, 효과 창의 ezShell 창 판정.
- 도우미 C# 컴파일 시험 (기존 도우미와 같은 방식).
- 실제 시스템 포인터를 바꾸는 확인은 사용자 PC 의 포인터를 바꾸므로, 화면 시험에서는 도우미의 `dryRun` 으로 명령만 확인한다.

## 진행
- [x] 1단계 시험 구현: 48·64px 포인터가 `SetSystemCursor` 로 그 크기 그대로 보이는지 확인. 사용자 PC 에서 32·48·64px 모두 그대로 보였다 (PNG 를 담은 `.cur` 를 `LoadImage` 로 읽음)
- [x] 1단계: `src/globalPointer.js`, `lib/pointerSystem.ts`, 설정의 `다른 프로그램에서도 쓰기`. 비정상 종료 대비는 표시 파일만이 아니라 도우미가 입력 끝(앱의 파이프가 닫힘)에서 되돌리는 것으로 했다
- [ ] 2단계
