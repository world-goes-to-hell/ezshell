# 작업 개요 단축키: Tab 두 번 → Ctrl+Alt+Space (바꿀 수 있음)

2026-11-24 사용자 요청: Tab 두 번 대신 다른 조합, 그리고 설정에서 바꿀 수 있게. 추천한 `Ctrl+Alt+Space` 로 승인.

## 왜
- 창 안의 처리기는 터미널 입력 중에도 Tab 두 번을 받아, 셸의 Tab 두 번 자동완성(bash 후보 목록, PowerShell 후보 넘기기)이 작업 개요를 열었다.
- 다른 프로그램에서는 두 번째 Tab 을 도우미가 가로채서, 편집기의 연속 들여쓰기에서 Tab 하나가 사라졌다.

## 동작
- 기본 `Ctrl+Alt+Space`. 설정 > 키보드 단축키의 `탭 이동` 묶음에 `로컬 작업 현황 열기`(개요 창의 제목) 로 나오고, 다른 단축키처럼 눌러서 바꾼다 (충돌 검사도 같다).
- 이 단축키만의 규칙: Ctrl·Alt·Shift 중 두 개 이상, 그 가운데 Ctrl 이나 Alt 가 있어야 한다. 다른 프로그램과 터미널 안에서도 키를 가져가므로, `Ctrl+O`·`Alt+B` 같은 한 수정키 조합은 셸(readline 의 Alt+B 등)과 모든 프로그램의 키를 빼앗는다.
- 단축키에 `Space` 를 쓸 수 있게 한다 (지금까지는 Enter·Esc 와 함께 받지 않았다).
- ezShell 이 앞에 있으면 창이 받는다: 캡처 단계에서 `matchesBinding` 으로 보므로 터미널에 입력 중에도 된다. Tab 두 번은 없앤다.
- 다른 프로그램이 앞에 있으면 도우미가 받는다: 그 키(누름·반복·뗌)는 앞의 프로그램에 가지 않는다. 수정키를 모두 뗀 뒤에 ezShell 을 앞으로 가져온다 (누른 채로 Alt 를 흉내 내 누르면 키 상태가 꼬인다). Alt 가 들어 있으면 누르는 순간 가짜 키(`vkE8`, AutoHotkey 의 메뉴 가림 키)를 한 번 넣어, Alt 를 뗄 때 앞 프로그램의 메뉴줄이 켜지지 않게 한다. 열리는 모니터 규칙(앞 창의 가운데)은 그대로.

## 보안 경계 (도우미, `src/globalDoubleTab.js`)
- 창은 키 이름 목록만 보내고(`work-overview-key`, 본창 주 프레임에서만), main 이 `overviewKeySpec` 으로 다시 검사해 숫자 두 개(수정키 비트, 가상 키 코드)로 바꿔 도우미에 `overview <mods> <vk>` 로 보낸다. 규칙에 맞지 않으면 `overview 0 0`(끔): 창 안의 단축키만 남는다.
- 도우미도 받은 숫자를 다시 본다 (수정키 비트 1·4·8 만, 두 개 이상, Ctrl 이나 Alt, 가상 키는 표에 있는 것만). 도우미가 main 에 보내는 것은 그대로 `ready`, `error`, `overview [x y]`, `capture`, `capture-cancel` 뿐이다. 키 값은 보내지 않는다.
- 주입된 키는 세지 않는다 (지금과 같다). 잠그면 `off` 로 끈다.

## 바꾸는 파일
- `src/globalDoubleTab.js`: Tab 두 번 제거, 단축키 판정(`IsOverviewChord`), 메뉴 가림 키, 뗄 때 실행, `overviewKeySpec`·`setOverviewKey`, 출력 `overview`.
- `main.js`: `onOverview`, IPC `work-overview-key`. `src/preload.js`·타입.
- `stores/shortcutsStore.ts`(항목·`note`), `lib/shortcutCapture.ts`(`Space`, `bindingProblemFor`), `Settings/ShortcutsPanel.tsx`, `Sidebar/WorkOverview.tsx`.
- 화면 테스트 고정 앱 `e2e/support/quickCaptureApp.js`(가짜 도우미에 `setOverviewKey`).

## 테스트
- 먼저: `overviewKeySpec`(허용·거부), 도우미에 숫자만 가는지, `overview` 줄만 받는지, C# 의 `IsOverviewChord`(반사), `bindingProblemFor`·Space 녹화.
- 화면 `local-work-overview`: 터미널 입력 중 `Ctrl+Alt+Space` 로 열림, Tab 두 번으로는 안 열림, 설정에서 다른 조합으로 바꾸면 새 조합만 열림, 한 수정키 조합은 이유와 함께 거부.

## 진행
- [x] 설계 (사용자 승인: 조합과 설정)
- [x] 테스트 먼저 → 도우미·main (C# 컴파일 시험 포함)
- [x] 창·설정 (이름은 개요 창 제목에 맞춰 `로컬 작업 현황 열기`)
- [x] 화면 테스트 `local-work-overview` 26개, `shortcuts` 22개, `quick-capture` 49개 통과. 단위 3,921개(두 번 연달아)
- [x] CLAUDE.md
- [x] 보안 검토 1회: 치명·높음 없음. 반영: 놓친 뗌 뒤의 붙잡은 키 해제(1.5초), 오래 기다린 조합 버림(5초), 단축키 변경·`off` 때 상태 초기화, 잠그는 순간 끄기, `overviewKeySpec` 의 구멍 난 배열·프로토타입 이름 거름. 테스트 임시 폴더는 이미 `finally` 에서 지운다.

## 구현 중 정한 것·찾은 것
- 도우미 스크립트가 PowerShell 명령줄 한도(32,767자)에 3천 자 남짓까지 다가가 있었다. `helperScript` 가 C# 의 줄 주석과 들여쓰기를 빼서 약 2만 4천 자로 줄이고, 2만 8천 자를 넘으면 단위 테스트가 실패한다. 컴파일 시험은 시험 코드가 더 붙어 임시 `.ps1` 파일로 돌린다.
- `shortcuts` 화면 테스트의 영역 캡처 확인이 `Ctrl+Alt+Shift` 줄이 생긴 뒤로 틀린 줄을 보고 있었다 (두 줄 모두 확인하게 고침).
- 실제 git 을 띄우는 단위 테스트(`gitCommit.test.js`, `localFiles.test.js` 의 git)가 전체 병렬 실행에서 가끔 5초를 넘겼고, 그 git 이 임시 폴더를 쥐고 있어 다음 테스트의 정리가 EPERM 으로 실패했다 (제한 30초, 정리는 10번까지 다시 시도). 고친 뒤 전체 3,922개가 두 번 연달아 통과.
