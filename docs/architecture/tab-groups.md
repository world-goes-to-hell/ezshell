# 탭 묶음과 내용 배치

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

## Tab Groups (작업별 탭 묶음)

탭 줄은 한 번에 한 작업의 탭만 보여 준다. 로컬 터미널 탭은 셸을 연 폴더가 속한 등록 프로젝트(같은 저장소의 워크트리는 한 묶음), SSH 탭은 그 작업에서 연 것만 그 작업(연결 설정의 `workGroup`: 작업의 `서버` 줄, 그 작업 탭 줄의 `+` 메뉴, 다시 열기도 유지), 세션 목록에서 연 SSH 탭은 프로젝트에 묶인 세션이라도 `일반`, DB 탭은 그 SSH 탭의 묶음, 나머지는 `일반` (`lib/tabGroups.ts`). 등록하지 않은 폴더에서 연 로컬 탭은 그 폴더의 묶음(`folder:<pathKey>`, 이름은 폴더 이름)이다. 폴더 없이 연 로컬 셸은 `일반`. 브라우저 탭은 열 때 앞에 있던 묶음을 갖는다 (폴더 묶음 포함). 지금 묶음은 따로 저장하지 않고 **앞에 있는 탭의 묶음**이라, 새 탭을 열거나 사이드바에서 탭으로 가면 저절로 바뀐다 (`hooks/useTabGroups.ts`). 탭 줄 왼쪽의 선택 상자(`Terminal/TabGroupChips.tsx`)는 지금 묶음 이름만 보이고 누르면 목록이 펼쳐진다 (`일반` 하나뿐이면 없음). 고르면 그 묶음에서 마지막으로 앞에 있던 탭으로 간다 (`stores/tabGroupStore.ts`, 메모리만). `Ctrl+Tab`·`Ctrl+숫자` 는 묶음 안에서만. 설계: `docs/plan/2026-11-19-tab-groups-by-project.md`. 화면 테스트 `local-tab-groups` (다른 명세에서 묶음을 바꿀 때는 `driver.pickTabGroup`).
- 숨은 탭은 그대로 산다 (탭 내용은 포털로 마운트 유지, 셸·에이전트·SSH 계속). 사이드바 숫자·에이전트 칩은 모든 탭 기준이다.
- 화면 좌우 나누기는 묶음이 바뀔 때 옛 묶음 몫으로 기억하고 닫으며, 그 묶음으로 돌아오면 그 묶음의 탭만으로 다시 나눈다. 탭을 닫아 앞 탭이 다른 묶음으로 넘어가면, 닫은 탭의 묶음에 탭이 남아 있는 한 그 묶음에 머문다. 앞에 있던 탭을 닫으면 바로 전에 보던 탭을 앞에 둔다: 같은 화면 칸의 탭 가운데 가장 최근에 앞에 있었던 탭이고, 묶음에 머물 때도 그 묶음에서 가장 최근에 본 탭이다 (`lib/tabRecency.ts`, `terminalStore` 의 `removeTerminal`, 2026-11-28 사용자 요청).
- 시험할 때: 묶음을 바꾼 직후에는 나가는 탭이 사라지는 움직임(AnimatePresence) 동안 탭 줄에 남아 있다. 탭 수를 셀 때는 줄어들 때까지 기다린다.

## Tab Content Hosts (배치가 바뀌어도 탭을 다시 만들지 않는다)

탭의 내용(TerminalPanel, DB 탭, 로컬 터미널)은 `App.tsx` 의 한 자리에서 `createPortal(..., tabHost(id), id)` 로 한 번만 그린다 (`lib/tabHosts.ts`: 탭마다 DOM 노드 하나). 단일 화면·주 패인·보조 패인의 자리는 `Terminal/TabSlot.tsx` 이고 그 노드를 자기 안으로 옮겨 붙인다. 그래서 single ↔ split 전환은 DOM 노드만 옮기고 탭을 언마운트하지 않는다. 이는 전환 중에 분할 셸이 닫히는 것을 막는다 (`docs/fix/2026-11-17-split-close-recreated-remaining-tab.md`).
- 포털을 그리는 자리는 `.terminal-area` 안이다. 탭 끌어 놓기 처리기가 `.terminal-area` 에 있고 React 이벤트는 React 트리를 따라 올라가므로, 밖에 두면 터미널 위에서의 끌어 놓기가 동작하지 않는다. 패인 포커스는 포털 내용의 감싸개(`.tab-host-content`)의 `onMouseDown` 이 준다.
- 바꾸면 안 되는 것: 탭 내용을 `TabSlot` 자리에서 직접 그리지 말 것. `TabSlot` 은 언마운트 때 노드를 떼지 않는다. 탭 내용의 React 이벤트는 패인(DOM 부모)이 아니라 그린 자리로 올라간다.
- 창 분리 등으로 TerminalPanel 이 실제로 언마운트되는 경우에는 여전히 xterm 을 다시 만들고, 화면은 스냅숏(`lib/terminalSnapshots`)과 `sshDataBuffers` 로 잇는다.
- 새 탭은 포커스가 있는 패인에 열린다 (스토어는 항상 주 패인에 넣으므로 `App.tsx` 의 effect 가 보조 패인으로 옮긴다). 분할 패인의 탭 줄에도 본 탭 줄과 같은 + 메뉴(`NewTabMenu`)가 있다.
