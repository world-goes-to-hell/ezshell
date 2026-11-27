# 하위 저장소 브랜치 바꾸기: 스마트 체크아웃

상태: 완료 (2026-11-27). 사용자가 IntelliJ 창(강제 / 스마트 / 체크아웃 안 함)을 기준으로 보여 주어, 강제 체크아웃도 넣었다. 강제는 변경을 버리지 않고 stash 백업으로 남기며 한 번 더 확인한다. 구현은 `src/ipc/nestedCheckout.js`, `NestedCheckoutProblem.tsx`.

## 배경

사이드바 하위 저장소의 **브랜치 바꾸기** 창은 수정·스테이징한 파일이 하나라도 있으면 Git 을 부르기 전에 거절한다 (`src/ipc/nestedRepositories.js` 의 `switchBranch`, "수정하거나 스테이징한 파일이 있습니다…"). IntelliJ 는 다음 순서로 처리한다.

1. 그냥 체크아웃을 시도한다. 바뀐 파일이 두 브랜치에서 같으면 Git 이 변경을 그대로 들고 넘어간다.
2. Git 이 "덮어쓴다"며 거절하면 **스마트 체크아웃**을 제안한다: 변경을 치워 두고(shelve/stash) → 체크아웃 → 다시 적용한다. 충돌이 나면 병합 창을 띄운다.

## 설계

### 1. 미리 거절하지 않고 먼저 시도한다

수정 파일이 있다는 이유만으로 거절하던 검사를 없애고 `git switch` 를 그대로 부른다. Git 은 덮어쓸 위험이 없을 때만 변경을 들고 넘어가고, 위험하면 아무것도 바꾸지 않고 실패한다. 실패 문구(`Your local changes to the following files would be overwritten`)에서 파일 목록을 읽어 창으로 돌려준다.

### 2. 거절되면 창에서 스마트 체크아웃을 제안한다

창에 "이 브랜치에서 바뀐 파일과 겹치는 수정 N개가 있습니다" + 파일 목록 + 버튼 **변경을 옮겨서 바꾸기**를 보여 준다. 누르면 main 이 한 큐 작업 안에서 순서대로 실행한다.

1. `git stash push -m "ezShell 스마트 체크아웃: <원래> → <대상>"` (추적 파일만. 추적하지 않는 파일은 Git 이 덮어쓰지 않는 한 그대로 남는다)
2. `git switch …` (지금과 같은 인자)
   - 실패하면 원래 브랜치에서 `git stash pop` 으로 되돌리고 오류를 알린다.
3. `git stash apply` 후, 충돌이 없으면 `git stash drop`.
   - 충돌이 나면 stash 를 지우지 않고 남긴다. 충돌 파일 목록과 "변경은 stash 에 보관되어 있습니다(메시지: …)" 를 알린다. 충돌 표시가 들어간 파일은 작업 공간의 Git 변경 화면에서 정리한다.

### 3. 안전 장치 (지금 것 유지)

- 병합·리베이스 진행 중 거절, 위험 설정 확인, `check-ref-format`, 같은 저장소 큐로 직렬화는 그대로 둔다.
- ~~변경을 버리는 강제 체크아웃은 넣지 않는다~~ → 강제 체크아웃은 stash 백업을 남기는 방식으로 넣었다 (되돌릴 수 있다).
- 브랜치 이름은 지금처럼 목록에 있는 것만 받는다. stash 메시지에 들어가는 이름도 그 목록 값이다.

## 바꿀 파일

- `src/ipc/nestedRepositories.js` (`switchBranch` 에 `smart` 옵션, 실패 문구 해석, stash 순서)
- `src/ipc/nestedRepositories.test.js` (깨끗함·들고 넘어감·거절·스마트 성공·적용 충돌·switch 실패 복구)
- `src/renderer/components/Sidebar/NestedRepositoryBranchDialog.tsx`, `stores/nestedRepositoryStore.ts`, 타입
- 화면 시험 `local-nested-repos` 에 한 경우 추가
- `docs/architecture/sidebar.md` 의 하위 저장소 절

## 검증

- 단위: 위 여섯 경우를 실제 임시 Git 저장소로 시험
- `npx vitest related`, `npm run typecheck`, `npm run build`, `npm run e2e -- local-nested-repos`
