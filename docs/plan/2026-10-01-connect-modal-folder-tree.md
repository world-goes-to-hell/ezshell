# 새 연결 모달의 폴더 선택을 폴더 트리로

## 요청 (사용자, 2026-10-01)
새 세션을 만들 때 폴더 선택을 사이드바 우클릭 "폴더로 이동" 처럼 개선.

## 기존
- 모달: `<select>` 에 폴더 이름만 평평하게 나열 → 하위 구조가 안 보이고 같은 이름 폴더를 구분할 수 없음
- 사이드바 "폴더로 이동": 폴더 트리 패널 (펼치기/접기, 폴더 색, 현재 위치 배지) — 마우스로만 선택 가능

## 설계
- 트리 렌더링을 공용 `components/FolderTree/FolderTree.tsx` 로 분리하고 두 곳이 같이 쓴다.
  - 트리 계산은 `lib/folderTree.ts` (`groupFoldersByParent`, `ancestorIds`, 테스트 3개)
  - 키보드: 행에 포커스(Tab), Enter/Space 선택, →/← 펼치기/접기
  - 표시 배지: 사이드바는 "현재"(클릭 불가), 모달은 "선택됨"(다시 골라도 됨)
- 모달은 `components/Modal/FolderPicker.tsx`: 선택된 폴더 경로(`getFolderPath`, "상위 / 하위")를 보여 주는 버튼 → 바로 아래에 트리를 **인라인으로** 펼침 (최대 240px 스크롤)
  - 떠 있는 드롭다운 대신 인라인: 모달 본문이 `max-height: 85vh; overflow-y: auto` 라 드롭다운이 잘리거나 이중 스크롤이 생김
  - Radix Dialog 는 Esc 를 document capture 단계에서 받아 모달을 닫는다 → `Dialog.Content onEscapeKeyDown` 에서 트리가 열려 있으면 트리만 닫는다 (입력값 유지)
  - 폼이 열려 있는 동안 선택된 폴더가 삭제되면 "폴더 없음 (최상위)" 로 표시

## 진행
- [x] lib + 테스트, FolderTree, FolderPicker, ConnectModal 연결, MoveToFolderSubmenu 를 FolderTree 로 교체
- [x] 타입 체크, 전체 테스트 통과
- [x] 실제 앱 확인 (임시 user-data-dir + 테스트 폴더): 새 연결 모달 11개 항목, 저장 후 폴더 반영, 폴더 우클릭 "세션 추가" 기본 선택, 편집 모달 표시·변경 저장, Esc 2단계, Tab/Enter, 다크/라이트 레이아웃, 사이드바 "폴더로 이동" 회귀, 콘솔 에러 없음
- 검증 중 발견한 기존 문제 → 사용자 요청으로 수정
  - [x] "폴더로 이동" 패널이 아래로 넘침 / 좁은 창에서 왼쪽 잘림 → `lib/sidePanelPlacement.ts`(테스트 5개): 오른쪽 → 왼쪽 → 창 안으로 밀기, 아래로 넘치면 위로. 폴더를 펼쳐 커지면 ResizeObserver 로 재배치
  - [x] 세션 이동 확인이 OS `confirm()` → 앱 안 확인 모달 `stores/confirmStore.ts`(`confirmDialog()`, 테스트 4개) + `components/Modal/ConfirmDialogHost.tsx`
    - 사이드바 메뉴의 세션 이동 / 연결 삭제 / 폴더 삭제에 적용 (같은 메뉴 안에서 일관되게)
    - 삭제는 빨간 버튼(`--error` 를 어둡게 섞어 모든 테마에서 흰 글자 대비 5:1 이상), 첫 포커스는 "취소" (습관적 Enter 로 삭제 방지)
    - 폴더 삭제 문구에 "안의 세션은 지워지지 않고 최상위로 옮겨짐" 추가 (실제 동작: `removeFolder` 가 세션의 folderId 를 비움)
    - 다른 곳(SFTP 삭제, 테마/스니펫 삭제, 명령 기록 삭제 등)의 confirm() 은 그대로 — 필요하면 confirmDialog 로 옮기면 됨
  - [x] 실제 앱 확인 23/23 (맨 아래 세션 패널이 위로 올라와 창 안, 폴더 펼쳐도 유지, 좁은 창에서 창 안으로, 이동/삭제 모달 Enter·Esc·첫 포커스, 폴더 삭제 후 세션 최상위 이동, Missing Description 경고 없음)
  - [x] 추가 발견 → 수정: 세션/폴더 우클릭 메뉴 자체가 커서 위치에 그대로 떠서 맨 아래 세션에서는 "폴더로 이동"·"삭제"가 창 밖이라 누를 수 없었다.
    `placeContextMenu`(테스트 4개): 커서 위치 → 넘치면 위쪽/왼쪽으로 펼침 → 그래도 안 되면 창 안으로. 열린 뒤 크기를 재서 배치(측정 전 숨김)
  - [ ] 메뉴 수정 실제 앱 확인 (실제 마우스 좌표로)
