# Radix Tooltip Trigger 안에 포털 메뉴(버튼 + DropdownMenu)를 넣으면 생기는 문제

## 상황
축소 사이드바에서는 세션 행 전체가 Radix `Tooltip.Trigger`(asChild) 다. 그 안에 탭 개수 배지 버튼과, 배지를 누르면 열리는 `DropdownMenu` 를 넣었다.
메뉴 Content 는 포털로 body 에 그려지지만 **React 트리에서는 여전히 세션 행의 자식**이다. React 합성 이벤트는 DOM 이 아니라 React 트리를 따라 전파되므로, 메뉴에서 생긴 이벤트가 행(= Tooltip Trigger)까지 올라간다.

## 증상과 원인 (세 가지가 따로 있었다)
1. **메뉴를 열면 세션 툴팁이 같이 열려 메뉴를 가린다 (포커스)**
   - 메뉴가 열리면 포커스가 메뉴 Content 로 간다. 이 focus 이벤트가 포털을 통과해 Trigger 의 `onFocus` 를 호출하고, Tooltip 이 열린다.
   - 메뉴를 닫을 때 포커스가 배지 버튼으로 돌아오는 것도 같은 경로로 툴팁을 연다.
   - 해결: 배지 컨테이너에서 `onFocus` 전파를 막는다.
2. **빠르게 누르면 여전히 툴팁이 메뉴 위에 뜬다 (대기 중인 열림 타이머)**
   - Tooltip 은 hover 후 지연 시간(250ms)이 지나야 열린다. Trigger 의 `onPointerDown` 은 "이미 열려 있을 때만" 닫고, 대기 중인 타이머는 `onClick` 에서 취소한다.
   - 배지 버튼의 click 전파를 막아 두었더니 타이머가 취소되지 않아, 메뉴가 열린 뒤에 툴팁이 떴다.
   - 해결: 배지의 click 은 전파되게 둔다. 행에는 click 핸들러가 없고 더블클릭(새 연결)만 막으면 충분하다.
   - 부수 증상: 툴팁이 떠 있으면 Esc 를 툴팁이 먼저 가져가서 메뉴가 닫히지 않는다.
3. **메뉴에서 항목을 고른 뒤, 같은 타일에 다시 마우스를 올려도 툴팁이 한 번 안 뜬다 (pointerleave 누락)**
   - 마우스가 배지에서 메뉴(포털)로 넘어가도 React 기준으로는 행 "안"이라 `onPointerLeave` 가 오지 않는다. 메뉴가 사라진 뒤에도 마찬가지다.
   - Tooltip Trigger 는 `hasPointerMoveOpenedRef` 를 pointerleave 에서만 되돌리므로, 다음 hover 를 무시한다.
   - 해결: 메뉴가 닫힐 때(`onOpenChange(false)`) 행 요소에 `pointerout`(relatedTarget = body) 을 직접 보낸다. React 가 이를 행의 `onPointerLeave` 로 바꿔 준다.

4. **탭으로 이동했는데 키보드 포커스가 배지에 남는다 (툴팁과는 별개, 같은 작업에서 발견)**
   - `TerminalPanel` 은 `isActive` 가 바뀔 때만 xterm 에 포커스를 준다. 이미 활성인 탭으로 "이동"하면 아무 일도 없다.
   - Radix DropdownMenu 는 닫힐 때 포커스를 Trigger(배지)로 되돌린다. 그래서 다른 탭을 골라도 포커스가 배지로 간다.
   - 해결: 스토어의 `focusRequest`(seq 증가)로 포커스를 요청하고, 항목을 고른 경우에만 `onCloseAutoFocus` 를 막는다.

## 판별 방법
- 목록/메뉴가 열린 직후 `document.querySelector('.session-tooltip')` 가 있는지 본다.
- CDP 로 "이동 → 즉시 클릭" 을 보내면 2번(타이머)이 재현된다. 사람 손으로는 잘 안 나와서 놓치기 쉽다.
- 3번은 "메뉴에서 선택 → 마우스를 밖으로 뺐다가 → 같은 타일에 다시 올림" 순서로만 재현된다.

## 다음에 비슷한 구조를 만들 때
- Tooltip/HoverCard Trigger 안에 포털을 띄우는 컴포넌트를 넣으면 focus, click, pointer enter/leave 가 모두 Trigger 로 올라간다는 점을 먼저 떠올린다.
- 포털 Content 에서 `onDoubleClick`, `onContextMenu` 도 행으로 올라간다 (메뉴 안에서 더블클릭하면 새 연결, 우클릭하면 세션 컨텍스트 메뉴). Content 에서 전파를 막는다.
- 가능하면 메뉴의 Root/Portal 을 Trigger 밖에 두는 구조가 가장 깔끔하다. 이번에는 한 행에 배지가 두 개(초록/빨강)라 Root 를 행 밖으로 빼기 어려워 위 방법을 썼다.

## 사례
2026-10-01 사이드바 세션 탭 배지. 관련 코드: `src/renderer/components/Sidebar/SessionTabBadge.tsx`, `SessionItem.tsx`. 계획: `docs/plan/2026-10-01-sidebar-session-tab-badge.md`
