# 2분할 → quad/tri 로 바꾸면 기존 분할 패널이 닫히고 새 셸로 다시 열리던 문제

## 증상
- 가로/세로 2분할에서 quad 로 바꾸면, 분할 패널에서 하던 작업(실행 중인 명령, 출력)이 사라지고 새 셸이 열렸다.
- 서버 기록: 기존 분할 셸 close → 새 셸 3개 open. (quad → tri 전환은 정상: 남는 패널 유지)

## 원인
`TerminalPanel.tsx` 가 분할 패널을 두 곳에서 따로 그렸다.
- 2분할: 조건부 Fragment 안의 key 없는 `div.split-terminal` > `SplitTerminal key="split-1"`
- quad/tri: `.terminal-split-container` 바로 아래 `div key="w-split-1"` > `SplitTerminal key="split-1"`

React key 는 같은 부모의 형제 사이에서만 통한다. `SplitTerminal` 의 key 가 같아도 부모가 달라
2분할 → quad 전환에서 React 가 기존 패널을 unmount(→ `sshSplitClose`)하고 새로 mount(→ 새 셸)했다.
CLAUDE.md 의 "모든 SplitTerminal 은 같은 트리 레벨" 설명은 quad ↔ tri 에만 맞았다.

## 수정
- 2분할 전용 분할 패널을 지우고, `w-split-1` 을 2분할에서도 렌더링 (`isSplit && (!isMultiSplit || quad || slots 에 split-1)`).
  2분할은 `{ flex: 1 - termSplitRatio }`, quad/tri 는 기존 grid 위치 스타일.
- 2분할 구분선은 그대로. 2분할에서는 다른 조건부 요소가 모두 비어 있어 DOM 순서(메인 → 구분선 → 분할)가 이전과 같다.
- 순서/형제 관계에 의존하는 CSS 가 없는 것을 확인했다.
- CLAUDE.md "SplitTerminal Key Stability" 를 실제 구조에 맞게 고쳤다.

## 한계
- tri 레이아웃 중 split-1 이 없는 배치(예: `tri-bottom` 의 split-2, split-3)에서 2분할로 가면 split-1 이 새로 열리고 나머지는 닫힌다.
  2분할이 항상 split-1 을 쓰기 때문이다. 필요하면 남은 패널을 2분할 패널로 옮기는 매핑을 따로 설계해야 한다.

## 검증
- 시연 화면: 수정 전 `compare-A.png` / `compare-B.png` (scratchpad)
- 타입 체크, 전체 테스트 통과
- 실제 앱 E2E (셸 번호 배너 + echo 마커 + 서버 SHELL-OPEN/CLOSE 로그)
  - 가로 2분할 → quad: 기존 분할 셸과 출력 유지(오른쪽 위 칸), 새 셸은 2개뿐, 닫힌 셸 없음
  - 세로 2분할 → quad: 같음
  - quad → 2분할(가로/세로), 다시 quad: w-split-1 셸 유지, 늘어난/줄어든 칸만 열림/닫힘
  - 회귀: quad → tri 병합 정상, 2분할 구분선 크기 조절 정상, 분할 해제 시 셸 닫힘·재분할 시 새 셸
  - 2분할 화면 배치가 수정 전과 픽셀 단위로 같음
  - 자동완성 42/42, 분할 11/11, 레이아웃 11/11, 콘솔 에러 없음
  - 수정 후 비교 화면: scratchpad `compare-A-fixed.png`
