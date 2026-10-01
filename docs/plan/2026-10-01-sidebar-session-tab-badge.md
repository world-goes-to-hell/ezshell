# 사이드바 세션에 열린 탭 개수 배지 표시

## 요구 사항 (사용자 요청 2026-10-01)
- 사이드바에 등록된 세션 중 열린 터미널 탭이 있으면, 세션 제목 옆에 탭 개수를 표시한다.
- 연결된 탭은 초록색 네모 테두리, 연결이 끊긴 탭은 빨간색 네모 테두리로 표시한다.
- 숫자를 누르면 해당 세션의 탭으로 이동한다.

## 사용자 결정 (2026-10-01)
- 연결된 탭과 끊긴 탭이 섞여 있으면 초록 배지와 빨강 배지를 나란히 표시한다.
- 배지의 탭이 1개면 바로 이동하고, 2개 이상이면 목록을 띄워서 고른다.
- 별도 창으로 분리한 탭은 세지 않는다.

## 확인한 사실
- 탭 ID 는 메인 프로세스가 만드는 `Date.now().toString()` 이고 (`main.js` `ssh-connect`), 사이드바 세션 ID 와 다르다.
- 탭과 사이드바 세션은 `TerminalInfo.connectConfig.savedSessionId` 로 연결된다 (`SessionPickerModal.tsx` 가 이미 이 방식을 쓴다). 탭 복제, 분리 창에서 합치기 모두 이 값을 유지한다.
- 연결 상태는 `TerminalInfo.connected` 에 있고 `ssh-closed` / `reconnecting` / `reconnected` / `reconnect-failed` 이벤트로 갱신된다. 끊긴 탭은 닫기 전까지 `terminals` 에 남는다.
- 기존 결함: `App.tsx` 의 `activeSessionIds` 는 탭 ID 집합인데 `SessionList` 가 `session.id`(사이드바 세션 ID)와 비교한다. 두 값이 달라서 사이드바의 "연결됨" 점과 `.active` 스타일, 축소 사이드바 툴팁의 "연결됨" 문구가 표시되지 않는다. 이번 작업에서 함께 바로잡는다.
- 탭을 별도 창으로 분리하면 메인 창의 `terminals` 에서 빠진다. 분리 창의 탭은 이번 범위에서 세지 않는다.
- 저장하지 않은 빠른 연결은 `savedSessionId` 가 없으므로 대상이 아니다.

## 설계
1. `lib/sessionTabs.ts` (순수 함수, 단위 테스트)
   - `groupTabsBySession(terminals)` → `Map<savedSessionId, { connected: SessionTab[], disconnected: SessionTab[] }>` (탭 순서 유지, `SessionTab = { id, label, index, path }`)
   - `findTabPane(layout, terminalId)` → 탭이 속한 패인
   - `badgeLabel(status, count)` → "연결된 탭 2개" / "연결이 끊긴 탭 1개"
2. `terminalStore.ts`: `focusTerminal(id)` 추가. 분할 모드에서는 탭이 속한 패인을 활성화하고(`setActivePaneTerminal` + `activePaneType`), 단일 모드에서는 `setActiveTerminal` 과 같게 동작한다.
3. `SessionList.tsx` 가 `terminalStore` 를 직접 구독해 그룹을 계산한다. `App.tsx` / `Sidebar.tsx` 의 `activeSessionIds` 전달은 없앤다.
4. `SessionItem.tsx` + `SessionTabBadge.tsx`(신규)
   - 연결된 탭이 있으면 초록 테두리 배지(개수), 끊긴 탭이 있으면 빨간 테두리 배지(개수). 섞여 있으면 두 배지를 나란히 표시한다.
   - 배지는 `<button>`. 탭이 1개면 클릭 시 바로 `focusTerminal`, 2개 이상이면 Radix `DropdownMenu` 로 탭 목록(제목, 탭 번호, 현재 경로, 현재 활성 탭 표시)을 띄운다.
   - 클릭/더블클릭이 행으로 전파되지 않게 막는다 (행 더블클릭은 새 연결이므로).
   - `aria-label` 과 툴팁: "연결된 탭 2개 · 눌러서 선택".
   - `isActive` 는 "연결된 탭이 하나 이상 있음" 으로 계산한다. 기존 초록 점(`StatusIndicator`)은 배지가 대신한다.
5. CSS (`SessionTabBadge.css`, `SidebarCompact.css`)
   - 색은 `--success`, `--error` 변수 사용. 네모 테두리(1px, radius-sm), 숫자는 tabular-nums.
   - 축소 사이드바(아이콘만)에서는 아이콘 타일 모서리에 작은 배지로 겹쳐 표시한다 (연결됨: 오른쪽 아래, 끊김: 오른쪽 위).
   - hover / focus-visible / active 상태 스타일.

## 진행 상황
- [x] 1. sessionTabs + 테스트 (15개)
- [x] 2. focusTerminal + 테스트 (8개, `stores/terminalStore.focus.test.ts`)
- [x] 3. SessionList 가 스토어 구독, `activeSessionIds` 전달 제거
- [x] 4. SessionItem 배지 (`SessionTabBadge.tsx`), 툴팁에 "연결된 탭 N개 / 연결이 끊긴 탭 N개"
- [x] 5. CSS (일반 / 축소 사이드바)
- [x] 타입 체크, 전체 테스트 1028개 통과
- [x] 실제 앱 E2E 44개 항목 통과 (분리된 `--user-data-dir`, 임시 SSH 서버 2233, CDP 9444)
  - 개수, 색, 1개 바로 이동, 2개 이상 목록, 현재 탭 표시, 끊김 → 빨강, 분할 모드, 축소 사이드바, 탭 닫기
- [x] 코드 리뷰 (CRITICAL/HIGH 없음, MEDIUM 3, LOW 4)
  - 반영: 배지로 이동한 뒤 키보드 포커스가 배지에 남던 문제. `focusTerminal` 이 `focusRequest`(sessionId, seq)를 올리고 `TerminalPanel` 이 새 요청일 때 xterm 에 포커스를 준다. 목록에서 탭을 고른 경우에는 Radix 가 포커스를 배지로 되돌리지 않게 한다 (`onCloseAutoFocus`). Esc 로 닫으면 기존대로 배지로 돌아간다.
  - 유지: 목록이 닫힐 때 행에 보내는 합성 `pointerout`. 리뷰가 제안한 제어형 Tooltip 으로는 Radix Trigger 내부의 `hasPointerMoveOpenedRef` 를 되돌릴 수 없다.
  - 보류: 분할 모드에서 "현재 탭" 표시는 포커스된 패인의 탭 하나만 가리킨다. 목록의 탭 번호는 `terminals` 순서(단일 모드 탭 바 순서)라서 분할 모드의 패인별 탭 순서와는 다를 수 있다.
- [x] 리뷰 반영 후 재검증: 타입 체크, 전체 테스트 1035개, E2E 44개, 포커스 4개 경우 (1개/여러 개 × 다른 탭/이미 활성인 탭)

- [x] 축소 사이드바 배지를 좌우 배치로 변경 (사용자 요청 2026-10-01)
  - 초록(연결됨)은 타일 왼쪽 위, 빨강(끊김)은 오른쪽 위. 한 종류만 있어도 자리가 바뀌지 않는다.
  - 이전에는 오른쪽 위/아래에 뒀는데, 위 세션의 초록과 아래 세션의 빨강 사이가 6px 라 너무 붙어 보였다. 지금은 세션 사이 간격이 35px 이다.
  - 왼쪽 배지에서 목록을 열면 목록이 세션 타일을 덮어서, 목록은 항상 사이드바 오른쪽 바깥에서 열리게 했다 (`sideOffset` 을 열 때 계산).
  - 재검증: 타입 체크, 전체 테스트 1043개, E2E 48개, 포커스 4개 경우

## 구현 중 메모
- 축소 사이드바에서는 세션 행이 Tooltip Trigger 라서, 배지와 목록(포털)의 focus/click/pointer 이벤트가 행으로 올라가 툴팁이 목록을 가리는 문제가 있었다. 세 가지 처리를 넣었다. 상세: `docs/brain/2026-10-01-react-events-bubble-through-portals-into-tooltip-trigger.md`
- 축소 사이드바 배지를 타일의 위/아래 모서리에 나눠 두면, 위 타일의 아래 배지와 아래 타일의 위 배지가 가까워져 어느 세션 것인지 헷갈린다. 그래서 두 배지를 같은 높이(위쪽)에 좌우로 둔다.
- 임시 SSH 서버에는 SFTP 가 없어 파일 탐색기의 `sftp-open` 오류가 콘솔에 찍힌다. 이번 기능과 무관하다.
- 재연결 중(`ssh-reconnecting`)인 탭은 `connected: false` 이므로 빨강으로 표시된다. 재연결에 성공하면 초록으로 돌아온다.
