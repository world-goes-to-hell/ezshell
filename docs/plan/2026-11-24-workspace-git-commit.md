# 작업 공간: 변경 탭 분리와 선택한 파일 커밋

작성: 2026-11-24. 상태: 완료 (2026-11-24, 화면 테스트 `local-workspace-files`·`local-workspace-browser`).

## 배경

작업 공간의 `Git 기록` 탭(`Workspace/WorkspaceBrowser.tsx` 의 `WorkspaceGit`)은 검색칸, `커밋하지 않은 변경`(`WorkspaceGitChanges.tsx` 의 `UncommittedChanges`), 커밋 목록을 한 화면에 그린다. main 의 `src/localFiles/git.js` 는 조회만 한다 (CLAUDE.md: "범위 밖: 스테이징·커밋·되돌리기 같은 Git 쓰기").

사용자 요청 (2026-11-24): Git 이력과 커밋하지 않은 변경을 분리하고, 커밋하지 않은 변경에서 사용자가 골라 커밋할 수 있게 한다. 설계 승인: 같은 날.

구분: 보안 경계 (앱이 처음으로 저장소에 쓴다). 권한·검증 경로는 테스트를 먼저 쓰고, 끝난 뒤 보안 검토 1회.

## 결정

### 1. 탭

- 작업 공간 탭: `대화 기록 · 파일 · 변경(새로 추가) · Git 기록`. `WorkspaceSection` 에 `changes` 를 더한다.
- `Git 기록` 은 검색과 커밋 목록만 남긴다.
- `변경` 탭: 머리줄(워크트리·하위 저장소 선택, 브랜치, 새로 고침) → 커밋 상자(메시지, `선택한 N개 파일 커밋`, 오류) → 요약 줄(전체 체크, `+추가 −삭제`, `N개 중 M개 선택`, 브랜치 → upstream) → 폴더 트리(체크박스).
- 대상 선택(워크트리·하위 저장소)은 두 탭이 같은 계산을 쓴다 (`useGitTarget`, `전체 브랜치` 는 기록 탭에만).

### 2. 커밋 방식

- 파일·폴더 줄에 체크박스. 폴더는 아래 파일 전체를 토글하고 일부만 체크되면 중간 상태.
- 커밋하면 체크한 파일의 지금 내용만 들어간다 (`git commit --only`). 체크하지 않은 파일은 스테이징 여부와 관계없이 그대로 남는다.
- 스테이징 상태로 바뀐 파일(이전 읽기에서는 스테이징되지 않았던 파일)은 자동으로 체크한다. 처음 읽을 때는 스테이징된 파일 전부가 체크된다. 사용자가 해제한 것은 다시 체크하지 않는다.
- 목록에서 사라진 경로는 선택에서 뺀다. 충돌 파일은 체크할 수 없다.
- 메시지와 선택은 저장소 최상위별로 메모리에만 둔다 (`stores/gitCommitStore.ts`, 탭을 옮겨도 남고 앱을 끄면 사라짐, 잠그면 지움).
- 커밋한 뒤: 알림 `커밋했습니다 · <짧은 해시>`, 메시지 비움, 목록 다시 읽기.
- `Ctrl+Enter` 로 커밋.

### 3. main (`src/localFiles/gitCommit.js`, IPC `workspace-git-commit`)

`git.js` 는 계속 읽기 전용으로 두고 쓰기는 새 모듈에 둔다.

- 입력 `{ root, files: string[], message: string }`. `root` 는 `roots.resolveRepoRoot` 로 검사 (열린 셸의 저장소와 그 안의 저장소만, 보안 검토 M2).
- 본창의 메인 프레임(`event.senderFrame === event.sender.mainFrame`)에서, 잠금 해제 상태에서만 받는다.
- `files`: 배열, 1~2,000개, 중복 없음, 각각 `requireRepoPath` 통과. main 이 `git status` 를 다시 읽고 **지금 변경 목록에 있는 경로만** 받는다. 하나라도 없으면 커밋하지 않는다 ("목록이 바뀌었습니다"). 충돌 파일은 거부.
- 스테이징된 이름 바꿈은 main 이 자기 status 의 옛 경로를 pathspec 에 붙인다 (옛 경로 삭제도 함께 커밋되게).
- `message`: 문자열, CRLF·CR → LF, 줄바꿈·탭 말고 제어 문자는 거부, 앞뒤 공백 정리 뒤 비어 있으면 거부, 5,000자 이하.
- 실행: 새 파일만 먼저 `git add`, 그 뒤 `git commit --only -m <메시지>`. 경로는 `--pathspec-from-file=- --pathspec-file-nul` 로 stdin 에 넘기고 `--literal-pathspecs` 로 글자 그대로 해석한다 (`*`·`[` 가 든 이름, `:(` 매직, 명령줄 길이 제한).
- 읽기와 같은 `-c core.fsmonitor=false` 등을 쓴다. 훅(pre-commit, commit-msg)은 터미널에서 커밋할 때처럼 실행한다. 제한 시간: 추가 30초, 커밋 2분.
- 실패하면 이번에 추가한 새 파일을 인덱스에서 뺀다 (`git rm --cached`), 작업 폴더의 파일은 그대로. git 의 오류 문구(훅 출력 포함)를 4,000자까지 돌려준다.
- 한 저장소에서는 커밋을 한 번에 하나만 한다 (진행 중이면 거부).
- 성공하면 `{ hash, shortHash, count }`.

### 범위 밖

push, amend, 변경 되돌리기, 줄 단위 커밋, 스테이징·해제 화면.

## 인터페이스

- `src/localFiles/gitCommit.js`: `requireCommitMessage(message) → string`, `commitSelected(folder, { files, message }) → Promise<{ hash, shortHash, count }>`
- `src/localFiles/git.js`: `SAFE` 내보내기 (같은 git 옵션을 쓰려고)
- `src/ipc/localProjects.js`: `workspace-git-commit`
- `src/preload.js`: `workspaceGitCommit(root, files, message)`
- `lib/gitCommitSelection.ts`: `folderCheckState`, `toggleFolder`, `toggleFile`, `nextSelection(previous, files)`, `selectableFiles`
- `stores/gitCommitStore.ts`: 저장소별 `{ message, selected, staged }`
- `Workspace/useGitTarget.tsx`: 대상 선택 계산과 선택 상자
- `Workspace/WorkspaceChanges.tsx`(탭), `Workspace/GitCommitBox.tsx`(커밋 상자)

## 테스트 (먼저 쓰는 것)

`src/localFiles/gitCommit.test.js` (실제 임시 저장소):

1. 고른 파일만 커밋되고, 고르지 않은 스테이징 파일은 스테이징된 채 남는다.
2. 새 파일을 고르면 커밋에 들어간다. 고르지 않은 새 파일은 추적되지 않은 채 남는다.
3. 삭제된 파일을 고르면 삭제가 커밋된다.
4. 스테이징된 이름 바꿈을 고르면 옛 경로 삭제도 커밋된다.
5. 변경 목록에 없는 경로(바뀌지 않은 파일, `.gitignore` 로 무시된 파일)를 섞으면 아무것도 커밋하지 않는다.
6. `..`·절대 경로·제어 문자 경로는 거부한다.
7. `[ab].txt` 같은 글롭 글자 이름은 그 파일만 커밋한다.
8. 메시지: 빈 값·공백만·5,000자 초과·제어 문자 거부, CRLF 는 LF 로, 따옴표·역슬래시·한글·여러 줄은 그대로 기록.
9. pre-commit 훅이 실패하면 커밋되지 않고, 이번에 추가한 새 파일은 다시 추적되지 않는 상태가 된다. 오류 문구에 훅 출력이 들어 있다.
10. 같은 저장소에 동시에 두 번 요청하면 두 번째는 거부한다.
11. 충돌 파일은 거부한다.

`lib/gitCommitSelection.test.ts`: 폴더 체크 상태(전체·일부·없음), 폴더·파일 토글, 새로 스테이징된 파일 자동 체크, 사라진 경로 정리, 충돌 파일 제외.

IPC 연결·화면은 typecheck 와 화면 테스트(`local-workspace-files` 에 변경 탭·커밋 확인 추가)로 대신한다.

## 진행

- [x] 1. main: 테스트 → `gitCommit.js` → IPC·preload·타입 (`gitCommit.test.js` 12개)
- [x] 2. 선택 계산·스토어 (`gitCommitSelection.test.ts` 7개)
- [x] 3. 화면: 탭 분리, `useGitTarget`, 변경 탭, 커밋 상자, 체크박스
- [x] 4. 화면 테스트 갱신 (`local-workspace-files`: 고르기·훅 거부·커밋·목록 밖 경로 거부, `local-workspace-browser`: 탭 이름, 고른 워크트리를 변경 탭이 따라감), typecheck, 전체 단위 테스트, 빌드
- [x] 5. 보안 검토 1회, CLAUDE.md 갱신

### 보안 검토 (2026-11-24) 반영

치명은 없었다.

| 지적 | 처리 |
|---|---|
| H1: `git` 을 이름으로 부르면 Windows 가 저장소 폴더의 `git.exe` 를 먼저 실행 | 재현되지 않음 (저장소 폴더에 `git.exe` 를 두고 `execFile('git', …, { cwd })` → 진짜 git 이 실행됨). 고치지 않음 |
| M1: post-commit 훅이 멈춰 시간 초과가 나면, 이미 된 커밋 뒤에 새 파일을 인덱스에서 빼 삭제가 스테이징됨 | 커밋 전 HEAD 를 기억하고, 실패해도 HEAD 가 바뀌었으면 되돌리지 않고 경고와 함께 성공 (`warning`, 알림이 경고로) |
| M2: 셸 폴더 아래 어디든 커밋 가능 (홈 폴더에서 연 셸이면 그 아래 모든 저장소) | `roots.resolveRepoRoot`: 열린 셸의 저장소(최상위·워크트리)와 그 안의 저장소만 |
| M3: 파일 창으로 `.git/hooks`·`.git/config` 를 쓸 수 있어, 커밋과 합치면 창이 프로그램 실행을 일으킴 | `roots.resolveInside` 가 `.git` 이 든 경로를 거부 (요청 경로와 실제 경로 둘 다) |
| L1: 중첩 저장소 `sub/` 를 고르면 링크로 커밋됨 | main 이 거부, 화면은 체크할 수 없게 |
| L2: 복사(`C`)의 원본까지 커밋됨 | 옛 경로는 이름 바꿈(`R`)만 |
| L3: 시간 초과 때 훅의 자식 프로세스·`index.lock` 이 남을 수 있음 | 안내 문구에 `index.lock` 확인을 적음 (프로세스 트리 종료는 하지 않음) |
| L4: 훅 출력의 색 코드·제어 문자 | 빼고 보여 줌. 환경 변수 허용 목록은 하지 않음 (터미널의 커밋과 같은 환경) |
| L5: 커밋 도중 잠가도 커밋은 계속 | 그대로 둠 (끊으면 `index.lock` 이 남는다) |
| L6: `git add` 가 도중에 실패하면 일부가 스테이징된 채 남음 | 실패해도 이번에 추가한 새 파일을 다시 뺌 |

### 만들면서 정한 것

- 저장소 선택(워크트리·하위 저장소)은 두 탭이 함께 쓰고 탭을 옮겨도 남는다. 기록 탭에서 고른 워크트리를 변경 탭에서 보면 다른 저장소가 보이는 것이 어색했다. 저장소 목록을 다 읽기 전에는 선택을 지우지 않는다 (다시 마운트될 때 기본값이 잠시 터미널 폴더라 다른 탭의 선택이 지워졌다).
- `git status` 해석에서 `AA`·`DD` 도 충돌로 표시한다 (전에는 `U` 가 든 것만).
- 커밋 명령에만 `core.safecrlf=false`: 줄 끝 경고(`LF will be replaced by CRLF`)가 훅 출력을 가렸다.
- 목록 위 브랜치 줄은 upstream 이 있을 때만 (머리줄에 브랜치가 이미 있다).
