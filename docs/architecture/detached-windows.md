# 분리 창 배율과 위치

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

## Detached Window Zoom (분리 창의 UI 배율)

분리 창 다섯 종류(서버 파일·SFTP·터미널·DB·MCP 활동)는 창 안 어디서든 Ctrl+휠로 그 창의 UI 배율만 바꾼다 (`Zoom/WindowZoom.tsx`, `App.tsx` 의 분리 창 분기마다 `<WindowZoom kind=…>`). 배율은 종류마다 `localStorage` 의 `windowZoom:<종류>` 에 남아 다음 창도 그 배율로 열린다 (`lib/windowZoom.ts`, 단계는 본창과 같은 `lib/appZoom.ts`). 본창 배율(`uiStore.appZoom`)과 따로다: Electron 은 배율을 그 창에만 적용한다 (같은 페이지를 연 두 창으로 확인). 표시는 본창과 같은 `ZoomBubble`. 처리기는 캡처 단계라 편집기·목록·xterm 이 Ctrl+휠을 받지 않는다. 실시간 보기의 휠 이동은 이제 Alt+휠만이다 (Ctrl+휠은 배율: 사용자 결정, 2026-11-19. Alt 가 창에 닿지 않는 PC 에서는 F8/F9 로 이동).

## Detached Window Places (분리 창의 위치 기억)

분리되는 창 다섯 종류(SFTP, 터미널, MCP 활동, 서버 파일, DB)는 종류마다 마지막으로 두었던 위치·크기·최대화 여부를 `userData/detached-window-state.json` 에 남기고, 그 종류의 다음 창을 그 자리에 연다 (`src/detachedPlaces.js`, `main.js` 의 `detachedWindowPlace`). 종류당 하나만 기억한다 (마지막으로 옮기거나 닫은 창의 자리). 같은 종류의 창이 그 자리에 이미 열려 있으면 30px 씩 오른쪽 아래로 비켜 연다. 저장된 자리가 지금 연결된 화면에 보이지 않으면 기본 크기로, 위치는 OS 가 정한다 (본창과 같은 검사: `windowState.usableState`, 최소 크기만 창 종류의 것). 탭을 끌어서 분리할 때도 같은 자리에 연다 (놓은 위치에 여는 동작은 원래 없었다). 설계: `docs/plan/2026-11-17-detached-window-places.md`.
- 새 분리 창을 만들면 `detachedPlaces.js` 의 `KINDS` 에 종류를 더하고 `detachedWindowPlace.open` → `options` → `track` 을 부른다. 파일에는 목록에 있는 종류만 쓴다.
- 바꾸면 안 되는 것: 아크릴이 있는 창(Glass 의 SFTP·터미널 창)은 `maximize()` 를 부르지 않고 `fill` 로 화면을 채운다 (`track` 의 네 번째 인자, 본창과 같은 이유).
- 새 `src/*.js` 라서 `MAIN_RUNTIME_MODULES` 에 있다.
