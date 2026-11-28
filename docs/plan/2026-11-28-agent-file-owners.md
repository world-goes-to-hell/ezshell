# 에이전트별 수정 파일 (누가 어떤 파일을 고쳤나)

2026-11-28 사용자 요청: 개선 제안 1번(에이전트 여럿이 한 폴더에서 일할 때). 순서는 1 → 3(진단 정보) → 2(CLI 판독 안정화). 개발E(claude-8)와 개발A(claude-2)가 나눠 만든다.

## 문제

여러 에이전트가 같은 작업 폴더의 main 에서 동시에 일한다. 지금은 누가 어떤 파일을 바꿨는지 사람이 메시지("병합 끝까지 손대지 마")와 규칙("내가 바꾼 것만 테스트")으로 맞춘다. 커밋할 때도 섞인 변경에서 내 것을 골라내야 한다.

## 정하는 것

1. 변경 탭의 파일마다 그 파일을 고친 에이전트(역할 이름)를 보인다.
2. 커밋 상자에서 "이 에이전트가 고친 파일만 고르기".
3. 두 에이전트 이상이 같은 커밋 전 파일을 고치면 겹침으로 표시한다.
4. (다음 단계) 겹침을 두 에이전트에게 알리기, 저장소 동결(병합 중 다른 에이전트의 편집 도구 막기).

## 어떻게 아나 (보안 규칙을 지키는 방식)

바꾸면 안 되는 규칙: 훅 입력의 도구 인자(파일 경로 포함)는 main 에도 보내지 않는다 (`docs/architecture/agent-hooks.md`). 그래서 경로는 훅에서 받지 않는다.

- main 이 에이전트 작업 폴더가 든 저장소 최상위를 `fs.watch(recursive)` 로 본다 (`.git`·설치·빌드 폴더 무시).
- 파일이 바뀐 시각을 그때 도구를 실행하던 에이전트와 짝짓는다. 이미 오는 훅의 `PreToolUse`·`PostToolUse`(`tool_use_id`, 리포터 시작 시각 `startedAt`)로 에이전트마다 열린 도구 구간을 안다.
  - 후보가 하나면 그 에이전트. 여럿이면 편집 도구(Claude `Edit`·`Write`·`MultiEdit`·`NotebookEdit`, Codex `apply_patch`)를 연 쪽을 우선한다. 그래도 여럿이면 모두 넣고 `uncertain`.
  - 도구 이름은 지금 `AskUserQuestion` 만 받는다. 위 편집 도구 이름을 고정 목록으로 더한다 (값은 목록 안의 이름뿐이고 인자는 여전히 읽지 않는다).
  - 실측 (2026-11-28, Codex 0.170 `exec --dangerously-bypass-hook-trust`, 임시 저장소): 파일 편집은 `PreToolUse`·`PostToolUse` 의 `tool_name: "apply_patch"`, 셸 명령은 `Bash`, 도구 id 는 `exec-<UUID>`. Pre 와 Post 사이 약 2초.
  - 훅 보고는 늦게 오므로 파일 변경을 잠시 모았다가 도구 구간이 닫힌 뒤(또는 몇 초 뒤) 정한다.
- 무시된 파일과 이미 커밋된 파일은 보이지 않는다: 질의 때 그 저장소의 `git status` 에 있는 경로만 돌려주고, 없어진 경로는 기록에서 지운다.
- 기록은 메모리에만 둔다 (앱을 다시 켜면 비어 있음). 잠그면 지운다.
- 한계: 훅이 없는 에이전트(승인 전 Codex, Antigravity)와 사람이 직접 고친 파일은 모른다(표시 없음). 같은 순간 두 에이전트가 도구를 돌리면 `uncertain` 이 된다.

## IPC 계약 (개발E main ↔ 개발A 화면)

- `workspace-file-owners` (invoke) `{ root }` → `{ success: true, owners: FileOwner[] }` 또는 `{ success: false, error }`.
  - `root`: 변경 탭이 보는 저장소 루트 (`workspace-git-status` 와 같은 값). 읽기라서 `roots.resolveRoot` 로 검사하고, 경로는 그 폴더의 저장소 최상위 기준이다 (`git status` 와 같음). 본창·잠금 해제에서만.
  - `FileOwner = { path: string, agents: { id: string, kind: 'claude' | 'codex', role?: string, lastAt: number }[], uncertain: boolean }`
  - `path` 는 저장소 기준 상대 경로, 구분자 `/` (`git status` 의 경로와 같은 모양). `agents` 는 `lastAt` 내림차순. 두 명 이상이면 겹침.
- `workspace-file-owners` 의 응답에는 `freeze: { since, except?: { id, role? }, reason? } | null` 도 있다 (그 저장소나 그것을 담은 저장소의 동결).
- `workspace-file-freeze` (invoke) `{ root, frozen: boolean, except?: agentId, reason?: string }` → `{ success: true, freeze }` 또는 `{ success: false, error }`. 메시지를 사용자 이름으로 보내므로 본창 메인 프레임·잠금 해제에서만, 루트는 `roots.resolveRepoRoot`(커밋과 같은 범위). preload `workspaceFileFreeze(root, frozen, except, reason)`.
- `workspace-file-owners-changed` (main → 본창 send) `{ root }`: 그 저장소의 기록이 바뀌었다 (`root` 는 저장소 최상위라 화면이 넘긴 값과 모양이 다를 수 있다). 화면은 보고 있는 저장소를 다시 invoke 한다 (모아서 0.5초에 한 번 이하로 보냄).

## 알리기 (2026-11-28 사용자 결정)

- 겹침: 나중에 고친 쪽에만 일반 메시지를 보낸다 (사용자 이름으로, 문장 앞 `[ezShell 자동 알림]`). 파일과 (먼저 고친 쪽 → 나중 쪽) 짝마다 한 번만 보낸다. 짝짓기가 `uncertain` 이면 보내지 않는다. 보내기 전에 `git status` 를 다시 읽어 이미 커밋된 쪽은 뺀다.
- 커밋: 커밋은 파일을 건드리지 않으므로 `.git/index`·`.git/HEAD` 변경을 보고 1초 뒤 `git status` 로 기록을 정리한다 (커밋된 변경으로 겹침 알림이 가지 않게).
- 저장소 동결: 막지 않고 알리기만 한다. 사용자가 변경 탭에서 동결하면, 그 저장소(안팎의 하위 저장소 포함)에서 일하는 다른 에이전트에게 긴급 메시지를 보낸다 (예외 에이전트 하나, 이유 200자 한 줄). 동결 중에 파일을 고친 에이전트에게는 동결마다 한 번 긴급 메시지를 더 보낸다. 해제하면 일반 메시지를 보낸다. 동결은 앱을 잠가도 남는다 (에이전트는 이미 들었고, 해제 알림만 풀어 준다). 앱을 다시 켜면 없어진다.
- Claude 편집을 실제로 막는 동기 훅, Codex 훅 추가(재승인 필요)는 하지 않기로 했다.

## 나누기

- 개발E: main. `src/ipc/agentFileOwners.js`(감시·짝짓기·기록), 훅 도구 이름 목록(`agentHookInput.js`·`agentHookEvent.js`), `localShell.js` 에서 훅 보고를 넘기기, IPC 등록·preload, 단위 테스트.
- 개발A: 화면. preload 타입, 스토어, 변경 탭 파일 줄의 에이전트 표시와 겹침 표시, 커밋 상자의 "에이전트로 고르기", 화면 테스트 명세.
