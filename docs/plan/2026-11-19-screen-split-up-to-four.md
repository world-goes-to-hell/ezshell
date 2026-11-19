# 화면 나누기를 4개까지

작성: 2026-11-19. 상태: 완료 (2026-11-19, 화면 테스트 `local-screen-split`).

## 배경

화면 나누기(탭을 나란히 보기)는 `주 화면 + 보조 화면` 두 자리뿐이다 (`LayoutState.primary/secondary`). 이미 둘로 나뉜 상태에서 탭을 오른쪽 끝으로 끌면 세 번째 화면이 생기지 않고 칸 병합(셸 분할)으로 처리된다 (사용자 보고, 2026-11-19). 사용자는 탭마다 따로 둔 채 3개 이상 나란히 보기를 원한다 (최대 4개).

## 지금 구조 (조사)

- 스토어 `terminalStore.ts`: `splitWithSession` 은 끌던 탭 하나와 나머지 전부로 레이아웃을 새로 만든다 (세 번째를 더할 수 없다). `addTerminalToPane`·`removeTerminalFromPane`·`moveTerminalBetweenPanes`·`setActivePaneTerminal` 은 두 이름에 대한 if/else 이고, 빈 화면을 접는 규칙이 셋에 반복돼 있다. `moveTerminalBetweenPanes` 의 `activePaneType` 은 `layout` 밖에 써서 효과가 없다 (버그).
- `App.tsx`: 두 화면을 손으로 쓴 두 열(`.split-pane.primary/.secondary`), 구분선 하나와 비율 하나(`splitRatio`, 저장 안 함). 화면 나누기 끌어 놓기 띠(48px)는 단일 탭 줄에서 끌 때만 생긴다: 나뉜 뒤에는 더 나눌 길이 없다.
- 두 자리를 가정하는 곳: `sessionTabs.findTabPane`, `localTerminalPane.visibleTerminalId`, `paneToTab.placeTab`, `usePaneDropOnTabs`, 새 탭을 포커스된 보조 화면으로 옮기는 코드 세 곳(App 두 곳, `DbConnectDialog`), 탭 다시 열기 기록(`restoreTabs` 의 `split`), 작업 묶음의 `SavedSplit`.

## 결정

- 레이아웃은 화면 목록이다: `panes: PaneState[]`(1~4), `sizes: number[]`(합 1), `activePane: number | null`, `direction`(`horizontal` 가로로 나란히 / `vertical` 위아래). 한 화면 안의 방향은 하나다 (좌우와 위아래를 섞지 않는다).
- 호환: `primary`(첫 화면)·`secondary`(둘째 화면)·`activePaneType` 은 스토어가 매번 `panes` 에서 다시 계산해 남긴다 (읽기용). 스토어 동작은 화면을 번호로 받고, 옛 이름 `'primary'`/`'secondary'` 도 0·1 로 받는다. 그래서 두 화면만 쓰는 기존 코드는 그대로 동작하고, 셋째 화면부터 필요한 곳만 번호로 바꾼다.
- 빈 화면 접기·포커스 규칙은 한 함수로 모은다 (`lib/screenPanes.ts`, 단위 테스트).
- 끌어 놓기:
  - 나뉘지 않은 화면: 지금처럼 가장자리 띠(48px)에 놓으면 둘로 나눈다.
  - 나뉜 화면: 화면의 탭 줄에서 탭을 끌어도 바깥 가장자리 띠가 생긴다. 나눈 방향의 양 끝(가로면 왼쪽·오른쪽 끝)에 놓으면 그쪽 끝에 새 화면을 만들고 탭을 옮긴다. 4개면 띠 대신 "화면은 4개까지" 를 알린다. 다른 방향의 끝(가로로 나눴는데 위·아래)은 막고 이유를 알린다.
  - 띠 안쪽은 지금처럼 칸 병합, 다른 화면의 탭 줄은 탭 옮기기.
- 구분선: 화면 사이마다 하나, 끌면 이웃한 두 화면의 몫만 바뀐다 (최소 12%). 두 번 누르면 모든 화면을 같은 폭으로. 몫은 레이아웃(스토어)에 두고 탭 다시 열기 기록에도 남긴다. (예전에는 구분선 두 번 누르기가 나누기 해제였다: 해제는 화면 탭 줄의 버튼으로 남긴다.)
- 탭 다시 열기 기록: `split` 에 `panes: number[][]`·`sizes`·`focus: number` 를 더하고 옛 `primary`/`secondary` 기록도 계속 읽는다 (업데이트 직후 옛 기록).
- 작업 묶음(`SavedSplit`)은 화면별 탭 목록·몫·포커스로 바꾼다.

## 하지 않는 것

좌우와 위아래를 섞은 배치(격자), 5개 이상, 화면 순서를 끌어 바꾸기.

## 확인

- 단위: `screenPanes.test.ts`(더하기·빼기·접기·옮기기·몫), 기존 `terminalStore.focus`, `sessionTabs`, `localTerminalPane`, `restoreTabs` 시험.
- 화면 테스트 `local-screen-split`(새): 로컬 탭 4개로 2 → 3 → 4 화면 만들기, 5번째는 안내, 구분선 끌기, 화면 하나 닫으면 나머지가 채움. 기존 `ssh-tab-merge`, `ssh-connection-motion`, `ssh-detach`, `ssh-restore-tabs`, `local-tab-groups`, `ssh-project-servers` 다시 확인.
