# Glass 표면 스타일과 창 투명도

작성일: 2026-11-17
상태: 구현 완료 (2026-11-17, 사용자가 목업 `glass-mode` 를 보고 "제안대로" 승인, 창 투명화 추가 요청)
구분: 중간 (UI 기능. main 에는 창 투명도 IPC 하나)

## Glass 표면 스타일
- 색 테마와 따로 고르는 선택이다: 설정 > 테마 > `표면 스타일: 플랫 / Glass`. `themeStore` 의 `surface` 에 저장하고 루트에 `data-surface="glass"` 와 `data-scheme="light|dark"` 를 붙인다. 규칙은 `styles/glass.css` 한 파일이고 모두 테마 변수에서 만든다.
- 세 겹: (1) 앱 뒤의 색 번짐(강조색·오류색·성공색을 바탕색 위에 옅게), (2) 패널(타이틀바, 사이드바, 탭 줄, 상태 줄, 패인·SFTP 머리줄)은 반투명 + 뒤 흐림, (3) 떠 있는 창(대화상자, 메뉴, 툴팁, 경로 목록, 겹쳐 열린 사이드바)은 반투명 + 뒤 흐림.
- 읽는 내용(터미널, SFTP 목록)은 거의 불투명하게 둔다. xterm 은 자기 배경을 불투명하게 칠하므로 터미널 글자의 대비는 그대로다.
- `high-contrast` 테마는 Glass 를 골라도 플랫으로 그린다 (`lib/appearance.ts` 의 `effectiveSurface`). OS 의 "투명도 줄이기" 설정에서는 불투명으로 돌아간다 (`prefers-reduced-transparency`).
- 기본값은 플랫이다 (뒤 흐림은 그래픽 처리를 더 쓴다. 원격 데스크톱·낮은 사양에서 느릴 수 있다).

## 창 투명도
- 창 전체를 비치게 한다 (`BrowserWindow.setOpacity`). 50~100%, 5% 단위. 설정 > 테마의 `창 투명도` 와 상태 줄의 물방울 버튼(`Footer/OpacityStatus.tsx`, 누르면 슬라이더)이 같은 값을 바꾼다.
- 값은 `themeStore` 의 `windowOpacity` 에 저장하고, 창이 뜰 때(`initializeTheme`) main 에 보낸다. 분리 창도 같은 경로로 자기 창에 적용한다.
- IPC `window-set-opacity`(`main.js`, `preload.js` 의 `setWindowOpacity`): 보낸 창에만 적용하고 main 이 0.5~1 로 다시 제한한다.
- 아크릴(바탕 화면을 흐리게 비추는 창 배경)이 아니라 불투명도를 고른 이유: 실행 중에 바로 켜고 끌 수 있고 Windows·macOS 에서 같게 동작한다. 아크릴은 창을 만들 때 정해야 하고 테두리 없는 창에서 문제가 알려져 있으며, 이 PC 에서 화면으로 확인할 방법이 없었다. 단점: 글자도 함께 옅어진다.

## 바꾸면 안 되는 것
- 창 투명도의 하한 0.5 는 렌더러(`clampWindowOpacity`)와 main 양쪽에 있다. 더 낮추면 창을 찾을 수 없게 된다.
- Glass 규칙에 테마 id 를 적지 않는다. 새 패널·떠 있는 창을 만들면 `glass.css` 의 해당 목록에 클래스를 더한다 (더하지 않으면 그 요소만 불투명하게 남는다).

## 검증
- 단위 테스트: `lib/appearance.test.ts` 6개.
- 화면: macOS Light(새 연결 창), macOS Dark(본창·로컬 터미널), Dracula(설정) 을 Glass 로 캡처해 확인. 상태 줄 버튼에서 70% 로 바꾸면 저장값이 0.7 이 되는 것 확인.
- 확인하지 못한 것: 실제 창이 비치는 모습 (Electron 창에서만 보인다), SFTP·DB 화면의 Glass 모습.

## 추가 (같은 날): 창 뒤가 비치는 진짜 Glass
사용자 지적: Glass 는 창 뒤의 배경을 비추는 것인데 지금은 빨강·파랑 그라데이션이다. 첫 구현은 앱 안에 색 번짐을 깔고 그것을 비추는 방식이었다. Windows 아크릴로 바꿨다.

### 시험으로 확인한 것 (Electron 28.3.3, Windows 11 빌드 26300, 시험 창을 화면 캡처로 확인)
| 방법 | 결과 |
|---|---|
| 생성 옵션 `backgroundMaterial: 'acrylic'` + `backgroundColor: '#00000000'`, `frame: false` | 아크릴이 그려짐 |
| 같은 옵션, `titleBarStyle: 'hidden'` | 아크릴이 그려짐 |
| 실행 중 `setBackgroundMaterial('acrylic')` (배경색을 투명으로 바꾸든, 처음부터 투명이든, 크기를 흔들든) | 그려지지 않음 (검게 보임) |
| `transparent: true` 만 | 뒤가 흐림 없이 그대로 보임 |
| `backgroundMaterial: 'mica'` | 거의 불투명 |

### 그래서 정한 구조
- 재질은 창을 만들 때만 줄 수 있으므로, 설정의 선택을 main 이 `userData/appearance.json`(`{surface, scheme}`)에 두고 다음 실행 때 본창을 아크릴로 만든다 (`src/nativeBackdrop.js`, `main.js` 의 본창 생성). Glass 를 켠 직후에는 색 번짐 배경이고, 다시 시작하면 창 뒤가 비친다. 설정 화면이 그 상태를 문장으로 알려 준다.
- 렌더러는 `appearance-set` 으로 선택을 알리고 `appearance-backdrop` 으로 이 창에 재질이 있는지 묻는다. 있으면 루트에 `data-backdrop="native"` 를 붙이고, `glass.css` 가 색 번짐을 없애고 html·body·`#root`·`.app-container` 를 투명하게 한다.
- 플랫으로 되돌리면 재질은 창에 남아 있지만 화면이 불투명하게 칠해져 보이지 않는다 (다시 시작하면 재질 없이 만든다).
- 재질의 색조는 OS 의 밝기 설정을 따르므로, 재질이 있을 때 `nativeTheme.themeSource` 를 테마의 밝기에 맞춘다.
- 본창만 해당한다. 분리 창은 색 번짐 배경이다. Windows 11 22H2 미만과 macOS 는 색 번짐 배경이다 (macOS 의 vibrancy 는 다루지 않았다).

### 바꾸면 안 되는 것
- `appearance-set` 은 본창에서 온 것만 받고, 파일에는 정해진 두 낱말만 쓴다 (`writeAppearance` 의 `normalize`). 창 생성 옵션이 이 파일에서 나오므로, 받은 값을 그대로 옵션으로 넘기지 않는다.
- 실행 중에 `setBackgroundMaterial` 로 켜는 방식으로 바꾸지 말 것 (그려지지 않는다, 위 표).

### 검증
- `src/nativeBackdrop.test.js` 6개.
- 아크릴로 만든 시험 창에 개발 서버 화면을 띄워 캡처: 사이드바·타이틀바·탭 줄·상태 줄에 창 뒤의 화면이 흐리게 비치고 터미널은 불투명. `data-backdrop="native"`, html·body·`#root` 배경이 투명인 것 확인.
- 확인하지 못한 것: 실제 앱에서 Glass 를 켜고 다시 시작하는 전체 흐름 (설정값이 사용자 프로필에 있어 대신 누를 수 없었다), 밝은 테마에서 `themeSource` 를 맞춘 뒤의 색조.

## 추가 2 (같은 날): 최대화하면 아크릴이 사라진다
사용자 보고: Glass 를 켜고 다시 시작했는데 비치지 않는다. 사용자의 창은 최대화 상태로 저장돼 있었다 (`window-state.json` 의 `isMaximized: true`).

### 시험으로 확인한 것 (같은 환경)
| 방법 | 결과 |
|---|---|
| 아크릴 창을 `maximize()` | 재질이 사라지고 검게 보임 (`frame: false`, `thickFrame`, `titleBarStyle: 'hidden'` 모두) |
| 최대화했다가 `unmaximize()` | 사라진 채로 남음 |
| 그 뒤 `setBackgroundMaterial('none')` → `('acrylic')` | 돌아오지 않음 |
| `setBounds(화면의 작업 영역)` 으로 채우기, 다시 원래 크기로 | 재질 유지 |
| `setOpacity(1)`, `setOpacity(0.8)`, `nativeTheme.themeSource` 설정 | 재질 유지 |
| `maximizable: false` 인 창에 코드로 `maximize()` | 최대화됨 (사용자 동작만 막는다) |

### 수정
- 아크릴이 있는 본창은 절대 최대화하지 않는다. 생성 옵션에 `maximizable: false`(제목 줄 두 번 누르기·위쪽 가장자리에 붙이기·Win+↑ 차단)를 주고, 최대화 버튼(`window-maximize`)과 저장된 최대화 상태의 복원은 창을 화면의 작업 영역 크기로 채운다 (`nativeBackdrop.createFillToggle`). 다시 누르면 원래 자리로 돌아간다.
- `windowState.trackWindow` 는 세 번째 인자로 "원래 크기"와 "최대화 여부"를 대신 답할 함수를 받는다 (채운 상태를 `isMaximized: true` 와 원래 크기로 저장).
- 재질이 없는 창(플랫, 분리 창)은 지금까지와 같이 최대화한다.

### 검증
- `nativeBackdrop.test.js` 9개 (채우기·되돌리기·사용자가 옮긴 뒤 다시 채우기).
- 실제 개발 앱을 새 코드로 띄워 그 모니터를 캡처: 창이 작업 영역을 채우고 빈 화면 영역이 검정이 아니라 반투명한 회색으로 보임 (재질이 살아 있음).
- 감수한 점: 채운 창은 진짜 최대화가 아니라서 모서리가 둥글고 끌어서 옮길 수 있다. 제목 줄을 두 번 눌러 최대화할 수 없다.

## 추가 3 (같은 날): 분리 창과 색 번짐
- 사용자 지적: SFTP 패널을 새 창으로 분리하면 빨강·파랑 그라데이션이 보인다. 분리 창은 재질 없이 만들어져 대체 배경(색 번짐)이 보인 것이다.
- 분리한 SFTP 창과 터미널 창도 Glass 를 고른 상태에서 만들면 아크릴로 만든다 (`main.js` 의 `glassWindowOptions`, `registerGlassWindow`). 재질이 있는 창의 목록(`glassWindows`)이 `appearance-backdrop` 의 답과 최대화 대체(작업 영역 채우기)를 맡는다. 파일 창·DB 창·MCP 활동 창은 내용이 편집기·표라 불투명 그대로 둔다.
- 재질이 없는 경우에만 보이는 대체 배경은 강조색 한 가지의 옅은 번짐으로 줄였다 (처음에는 오류색·성공색을 섞어 빨강·초록 얼룩처럼 보였다).
