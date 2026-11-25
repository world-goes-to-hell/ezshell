# 앱 단축키와 전역 작업 개요

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

## Work Overview Shortcut From Any Program (다른 프로그램에서도 단축키로 작업 개요)

`Ctrl+Alt+Space`(설정 > 키보드 단축키의 `탭 이동` 묶음 `로컬 작업 현황 열기`, 바꿀 수 있음)가 작업 개요(창 제목 `로컬 작업 현황`, `Sidebar/WorkOverview.tsx`)를 연다. ezShell 이 앞에 있으면 창의 처리기가 캡처 단계에서 `matchesBinding` 으로 받으므로 터미널에 입력 중에도 되고 키가 셸에 가지 않는다. 다른 프로그램이 앞에 있어도 ezShell 이 켜져 있으면 열린다. 2026-11-24 까지는 Tab 두 번이었다: 셸의 Tab 두 번 자동완성이 개요를 열고 편집기의 연속 들여쓰기에서 Tab 이 사라져 바꿨다 (사용자 요청, 설계 `docs/plan/2026-11-24-work-overview-shortcut.md`). 창은 포커스가 있을 때만 키를 들으므로, main 이 Windows 에서 도우미(Windows PowerShell 이 C# 을 `Add-Type` 으로 올림, `src/globalDoubleTab.js`)를 띄워 저수준 키보드 후크(`WH_KEYBOARD_LL`)를 건다. 창이 바뀐 단축키를 `work-overview-key` 로 main 에 알리고(본창 주 프레임에서만, 키 이름 목록), main 이 `overviewKeySpec` 으로 검사해 숫자 두 개(수정키 비트 Ctrl 1·Alt 4·Shift 8, 가상 키)만 `overview <mods> <vk>` 로 도우미에 준다 (규칙에 안 맞으면 `overview 0 0`: 창 안에서만 동작). 도우미가 그 키를 알아채면, 수정키를 모두 뗀 뒤 ezShell 창을 앞으로 가져오고(최소화면 복원, Alt 한 번을 넣은 뒤 `SetForegroundWindow`: Windows 는 막 입력을 받은 프로세스만 앞으로 올 수 있게 한다) `overview` 한 줄을 알리며, main 이 창에 `work-overview-request` 를 보내 같은 개요를 연다.
- 이 단축키만의 규칙 (창 `lib/shortcutCapture.ts` 의 `bindingProblemFor`, main `overviewKeySpec`, 도우미 `SetOverview` 가 같은 규칙을 따로 본다): Ctrl·Alt·Shift 중 두 개 이상, 그 가운데 Ctrl 이나 Alt. Tab 조합은 안 된다. 바꾸면 안 되는 것: 한 수정키 조합(`Ctrl+O`, `Alt+B`)을 허용하지 말 것. 다른 프로그램과 셸(readline 의 Alt+B 등)의 키를 빼앗는다. 단축키 녹화는 이 때문에 `Space` 를 받는다 (`mainKeyOf`). macOS 에서는 창 안에서만이고 `Cmd+Option+Space` 는 Finder 검색 창과 겹칠 수 있다.
- 다른 프로그램에서 연 개요는 그 프로그램이 있던 모니터에 뜬다. 도우미가 단축키를 받는 순간 앞에 있던 창을 기억했다가, ezShell 을 앞으로 가져오기 전에 그 창의 가운데를 물리 픽셀로 읽어(`GetWindowRect`, 그 스레드만 `SetThreadDpiAwarenessContext` 로 모니터별 DPI) `overview <x> <y>` 로 알리고, main 이 `screen.screenToDipPoint` → `getDisplayNearestPoint` 로 모니터를 정한다. `workOverview.aimAt` 이 만든 요청 번호를 같은 본창 주 프레임에서 3초 안에 한 번만 쓴다. 외부 단축키는 흐림·어두운 배경으로 바로 열고, 창 안에서 연 개요의 배경에는 현재 모니터 캡처를 쓴다. Windows에서 여러 모니터를 캡처할 때 `desktopCapturer.getSources` 호출이 main을 막아 외부 단축키에서 캡처를 뺐다 (`docs/fix/2026-11-25-work-overview-external-shortcut-speed.md`). 전체 화면으로 들어갈 때 본창을 대상 모니터의 작업 영역 가운데로 옮긴다. 닫으면 전체 화면이 풀린 뒤(`leave-full-screen`, 0.6초 안전 타이머) 원래 위치·크기로, 최대화였으면 다시 최대화한다 (`src/ipc/workOverview.js` 의 `placeOn`·`putBack`). 탭을 골라 닫아도 본창은 원래 모니터로 돌아간다. ezShell 안에서 누른 단축키와 이미 전체 화면인 본창은 옮기지 않는다.
- 키 입력 보호. 도우미가 main에 보내는 신호는 시작 상태, 작업 개요와 캡처 동작이다. `overview`에는 앞에 있던 창의 가운데 좌표 두 개만 붙는다. 키 값은 기록하거나 보내지 않는다. 주입된 키(`LLKHF_INJECTED`)는 세지 않는다. ezShell이 앞에 있을 때 단축키는 창의 처리기로 전달한다. 다른 프로그램이 앞이면 그 키의 누름·반복·뗌을 그 프로그램에 보내지 않고, Alt 가 든 조합이면 누르는 순간 아무 일도 하지 않는 키(`vkE8`, AutoHotkey 의 메뉴 가림 키)를 넣어 Alt 를 뗄 때 그 프로그램의 메뉴줄이 켜지지 않게 한다. 바꾸면 안 되는 것: ezShell 을 앞으로 가져오는 일(Alt 흉내)은 수정키를 모두 뗀 뒤에 한다 (누르고 있는 동안 넣으면 키 상태가 꼬인다). 보안 검토 반영: 붙잡은 키의 뗌을 놓쳤을 때(Win+L·UAC 같은 보안 데스크톱이 가져감) 1.5초 넘게 조용하다가 온 누름은 새 누름으로 보고 놓아준다 (`KeepHeldKey`: 비밀번호 칸의 Space 하나가 사라지지 않게), 5초 넘게 수정키를 기다린 조합은 버린다 (`FrontStillWaiting`: 엉뚱한 때 ezShell 이 포커스를 가져가지 않게), 새 단축키·`off` 는 붙잡은 키를 놓는다, 잠그는 순간 main 이 `setEnabled(false)` 를 보낸다 (1초 확인만으로는 틈이 있었다). `overviewKeySpec` 은 구멍 난 배열·`constructor` 같은 이름을 거른다 (`Object.hasOwn`). 수정키 없는 Esc는 캡처 중 덮개가 앞에 없을 때만 도우미가 처리한다. 앱이 잠기면 main이 보내는 `off`로 판정을 끄고, main이 종료되면 도우미 입력이 닫혀 도우미도 끝난다.
- C# 을 고칠 때: `Add-Type` 은 경고도 오류로 처리한다 (값을 넣지 않은 필드 CS0649 등: 도우미가 뜨지 않고 창 안의 단축키만 남는다). 바꾸면 안 되는 것: 스크립트는 PowerShell 명령줄(`-EncodedCommand`, UTF-16 을 base64 로)에 실리고 Windows 는 32,767자에서 자른다. `helperScript` 가 C#의 줄 주석과 구분자 주변의 공백을 빼고, 2만 8천 자를 넘으면 단위 테스트가 실패한다 (넘으면 도우미가 말없이 뜨지 않는다. 컴파일 시험은 시험 코드가 더 붙어 임시 `.ps1` 파일로 돌린다). 시험용 `dryRun` 필드(반사로만 켬)는 시험 중 창을 올리거나 키를 주입하지 않는다. 실패하면 2·4·6초 뒤 세 번까지 다시 띄운다. Windows 만 (다른 OS 는 손으로 허락하는 권한이 필요하다). 새 `src/*.js` 라서 `MAIN_RUNTIME_MODULES` 에 있다 (파일 이름은 예전 기능 이름 그대로 `globalDoubleTab.js`).

- 현재 인코딩된 도우미는 27,868자로 28,000자 시험 상한에 가깝다. 다음 도우미 변경 때는 먼저 줄일 코드를 찾아 여유를 확보한다.

## Quick Capture Shortcuts (영역 캡처)

설정 > 키보드 단축키에서 Windows 전역 영역 캡처 두 줄을 각각 바꾸거나 `사용 안 함`으로 끈다. 기본값은 `Ctrl+Alt+Shift`와 `Ctrl+Win+Alt`이며, 각 줄의 기본값으로 되돌리거나 모두 초기화할 수 있다. 두 줄을 모두 꺼도 명령 팔레트에서 영역 캡처를 연다.

- 수정키만 쓰려면 Ctrl·Win·Alt·Shift 중 세 개 이상을 함께 누르고 모두 뗀다. 주 키가 있는 조합은 작업 개요와 같은 허용 목록에서 고른다. Ctrl·Alt·Shift 중 두 개 이상에 주 키 하나를 붙인다. Win과 Tab은 주 키가 있는 조합에 쓸 수 없다. 이미 작업 개요나 다른 줄에서 쓰는 조합은 거절하고 설정의 해당 줄에 이유를 표시한다.
- `shortcutCapture.ts`에서 수정키의 눌림과 뗌을 읽는다. 기록 중 본창의 캡처 단계가 키를 가져가고 main은 도우미를 끈다. 녹화를 마친 뒤 값은 `customShortcuts`에 저장되며 화면 설정 백업에 포함된다. 끈 줄은 빈 배열이다. `quick-capture-keys` IPC는 잠금 해제된 본창 주 프레임의 설정만 받는다.
- `captureKeySpec`은 main에서 키 이름과 조합을 검사하고 작업 개요 및 캡처 두 줄의 충돌을 걸러 낸다. 도우미에는 숫자 네 개를 `bindings <mods1> <vk1> <mods2> <vk2>`로 보낸다. 가상 키가 0이면 수정키 전용이며 두 숫자가 모두 0이면 그 줄은 꺼져 있다. C#에서도 수정키 개수와 가상 키 범위를 검사한다. 도우미는 키를 기록하지 않고 동작 신호만 보낸다.
- 수정키 전용 조합은 마지막 수정키를 떼면 `capture`를 보낸다. 주 키 조합은 누른 순간 `capture-press`를 보내 화면 읽기를 시작하고, 수정키를 모두 뗀 뒤 `capture-release`가 와야 덮개가 앞으로 온다. 다른 앱에 주 키가 전달되지 않도록 누름·반복·뗌을 가로채고 Alt 조합에는 메뉴 가림 키를 넣는다. 작업 개요와 같은 `KeepHeldKey` 규칙이 보안 데스크톱에서 뗌을 놓친 뒤의 새 누름을 보호한다. 5초 안에 뗌이 없거나 도중에 잠금·재설정·도우미 종료가 일어나면 대기 중인 캡처를 끝낸다.
- Windows 단위 테스트에서 C#을 컴파일하고 실제 후크 없이 판정 함수를 호출한다. 숨김 화면 테스트는 도우미의 숫자 명령에 응답하는 시험 프로세스를 써서 설정과 덮개를 확인한다.

## Keyboard Shortcuts (단축키와 사용자 지정)

앱 단축키는 `stores/shortcutsStore.ts` 의 목록이고 `hooks/useKeyboardShortcuts.ts` 가 처리한다. 설정 > 키보드 단축키(`Settings/ShortcutsPanel.tsx`)에서 줄의 키를 누른 뒤 새 조합을 누르면 바뀐다 (`customBindings`, `localStorage` 의 `customShortcuts`). 읽기와 검사는 `lib/shortcutCapture.ts`.
- 저장 형식은 기본값과 같은 `['Ctrl', 'Shift', 'P']` 이고 `Ctrl` 은 "앱의 주 수정키"다: Windows·Linux 는 Control, macOS 는 Command. 그래서 저장값의 뜻이 어느 OS 에서나 같다.
- 글자·숫자는 키의 자리(`event.code`)로 읽고 비교한다 (`mainKeyOf`): 한글 입력 상태에서는 `event.key` 가 `ㅔ` 라서 `Ctrl+P` 가 맞지 않았다.
- 거부하는 조합: 수정키 없는 글자, 복사·붙여넣기·실행 취소 키(`Ctrl+C/V/X/A/Z`), macOS 의 메뉴 키(`⌘Q/H/M`)와 Control 조합, 다른 단축키가 쓰는 조합 (이유를 줄 아래에 보여 준다). 저장된 값은 시작할 때 형식을 검사해 읽는다 (`parseCustomBindings`).
- 바꾸면 안 되는 것: 녹화 중에는 창의 캡처 단계에서 모든 키를 가로채 `stopImmediatePropagation` 한다 (누른 조합이 다른 단축키를 실행하거나 설정 창을 닫으면 안 된다).
- 바꾸면 안 되는 것: 이 훅은 여러 곳(App, Sidebar)에서 쓰인다. 처리기가 있는 호출만 `preventDefault` 한다. 처리기가 없는 쪽이 먼저 `preventDefault` 하면 처리기가 있는 쪽이 `defaultPrevented` 를 보고 건너뛴다 (명령 팔레트 단축키가 그래서 훅으로는 동작하지 않았고, `CommandPalette` 가 따로 듣던 고정 `Ctrl+P` 가 가려 주고 있었다. 그 고정 처리기는 없앴다: 단축키를 바꿔도 옛 키가 계속 동작했다).
- 터미널에 입력 중일 때는 명령 팔레트 단축키만 동작한다 (xterm 의 입력칸이 `TEXTAREA` 라서 나머지는 건너뛴다).
- 시험할 때: 시험용 앱을 `TaskStop` 으로 끄면 `npx` 만 끝나고 Electron 은 남아 CDP 포트를 잡고 있다. 새로 띄운 앱 대신 옛 앱(옛 코드)에 붙게 되므로, 프로필 경로로 남은 `electron.exe` 를 찾아 끝낸 뒤 다시 띄운다.
