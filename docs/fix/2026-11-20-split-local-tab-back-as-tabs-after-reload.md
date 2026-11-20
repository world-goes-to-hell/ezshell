# 창을 다시 불러온 뒤 분할 로컬 탭의 칸이 각자 탭으로 돌아오던 문제

## 증상

분할해 둔 로컬 터미널 탭이, 앱을 다시 띄운 뒤에 칸마다 따로 된 탭으로 열렸다 (2026-11-20 사용자 보고).

## 원인

로컬 탭을 되살리는 경로는 두 가지다.

1. 앱 재시작: 닫을 때 남긴 기록(`restore-tabs`)으로 다시 연다. 기록에 분할 트리가 들어 있어 칸 배치째 열린다 (`local-restore-agents` 가 확인).
2. 창만 다시 불러오기: main 의 셸은 살아 있고 창의 탭만 사라진다. `localShellAdopt.ts` 가 남은 셸을 탭으로 되살리는데, 어느 셸이 어느 탭의 어느 칸이었는지는 창의 메모리(`localPaneShells` 와 스토어의 분할 트리)에만 있어서 셸마다 탭을 하나씩 만들었다.

증상은 2번이다. 개발 실행(`npm run dev`)에서는 다른 세션이 `preload.js` 를 고칠 때마다 electron-vite 가 창을 다시 불러와서 자주 일어났다. 설치본에서도 화면이 비정상 종료된 뒤에 같은 일이 생긴다.

## 수정

- 창이 사라질 때(`pagehide`, 다시 불러오기 포함) 로컬 탭마다 탭 id, 주 셸 id, 이름, 폴더, 분할 트리, 칸별 셸 id 를 그 창의 `sessionStorage` 에 적는다 (`lib/localReloadLayout.ts` 의 `snapshotLocalTabs`, `writeReloadLayout`).
- 다시 불러온 창은 셸을 되살릴 때 그 기록을 한 번 읽고 지운 뒤(`takeReloadLayout`), 기록의 탭마다 칸에 같은 셸을 먼저 붙이고(`adoptLocalPaneShell`) 탭을 분할 트리째 만든다 (`planReloadedTabs`).
- 주 셸이 끝난 탭은 되살리지 않고, 남은 셸은 예전처럼 각자 탭이 된다. 셸이 끝난 칸은 트리에서 접는다. 한 셸은 한 칸에만 준다.

`sessionStorage` 를 쓴 이유: 같은 창을 다시 불러올 때만 남고 창을 닫으면 사라진다. 이 기록은 그 경우에만 필요하다. 셸 id·탭 이름·폴더만 담고 터미널 내용은 담지 않는다. 읽을 때 id 형식(`local:<번호>`, `split-<번호>`), 트리(`restoreTabs.readTree`), 글자의 제어 문자를 다시 검사한다.

## 확인

- 단위 테스트 `localReloadLayout.test.ts` 7개.
- 화면 테스트 `local-reload-split`(새로 추가): 분할한 탭이 다시 불러온 뒤 한 탭, 두 칸, 같은 셸 id, 같은 이름으로 돌아온다. `local-reload`, `local-restore-agents` 도 통과.

## 남은 것

화면 나누기(탭 여럿을 나란히 보기) 배치는 다시 불러오기 뒤에 되살리지 않는다.
