# Claude 계정을 바꿔도 같은 칸에서 대화를 이어 가기

상태: 구현 완료 (2026-11-27 승인, 커밋 전)

## 요청 (2026-11-27)

채팅 머리줄의 계정 메뉴에서 다른 계정을 고르면 지금은 새 탭에서 새 세션이 열린다. 지금 칸에서 지금 대화를 그대로 이어 가고 싶다.

## 지금 동작

- `ClaudeProfileMenu.tsx` → `App.tsx` 의 `OPEN_CLAUDE_PROFILE_EVENT` 처리 → `localShellOpen({ agent: 'claude', claudeProfileId, reuseClaudeProfile: true })`.
- 같은 폴더에 그 계정 칸이 있으면 그 칸으로 포커스를 옮기고, 없으면 새 탭을 연다. 대화는 넘어가지 않는다.
- 계정마다 `CLAUDE_CONFIG_DIR` 가 다르다 (기본 계정: `~/.claude`, 추가 계정: `userData/claude-profiles/<id>`). 대화 기록 `projects/<폴더 이름>/<세션 ID>.jsonl` 과 같은 이름의 폴더(`tool-results`, 하위 에이전트 기록)가 계정 폴더 안에 있다. 그래서 다른 계정의 Claude 는 `--resume <세션 ID>` 로 이 대화를 찾지 못한다.

## 설계

이미 있는 "기록을 끌어 놓아 칸에서 이어 열기"(`agentSessionDrop.ts` 의 `replaceAgentPane`, `localShellOpen` 의 `replacementFor`)와 같은 방식으로 칸의 셸만 바꿔 끼운다.

1. 계정 메뉴에 항목을 나눈다.
   - `<계정> 으로 이 대화 이어 가기` (새 기본 동작): 지금 칸에서 바꾼다.
   - `<계정> 새 세션` : 지금 동작 그대로 (같은 폴더의 그 계정 칸으로 이동하거나 새 탭).
2. main 의 새 IPC `claude-profile-switch-in-place(shellId, profileId)`.
   - 본창 주 프레임과 잠금 해제를 확인한다 (계정 IPC 와 같은 검사).
   - 원본 세션은 화면이 보낸 값을 쓰지 않는다. main 이 그 셸의 에이전트에서 확인한 Claude 세션 ID(훅·상태 줄로 확인된 세션)와 셸의 계정 ID 로 정한다.
   - 쉬는 상태(`idle`)에서만 진행한다. 작업 중이면 "작업이 끝난 뒤 다시 시도해 주세요".
   - 원본 계정 폴더의 `projects/<폴더>/<세션>.jsonl` 과 `<세션>/` 을 대상 계정 폴더의 같은 상대 경로로 복사한다. 경로는 main 이 계정 루트와 세션 ID(UUID 검사)로만 만들고, 실제 경로가 두 계정 루트 안인지와 심볼릭 링크 여부를 확인한다. 대상에 같은 세션 파일이 이미 있으면 덮어쓰지 않고 이름을 바꿔 보관한다.
   - `localShells.open({ agent: 'claude', claudeProfileId: 대상, resume: 세션, replacementFor: shellId, cwd: 원래 실행 폴더 })` 로 새 셸을 연다.
3. 화면은 `replaceAgentPane` 과 같은 순서로 새 셸을 칸에 붙이고 옛 셸을 닫는다. 채팅 보기였으면 채팅 보기를 유지한다.
4. 역할 이름과 받은편지함의 안 읽은 메시지가 새 에이전트로 넘어가는지 확인한다. 기록 끌어 놓기 경로가 하는 만큼은 맞추고, 빠지는 것이 있으면 이어 붙인다.

## 사용자에게 보이는 차이

- 대화 내용은 이어지지만 Claude 프로세스는 새로 뜬다. 다른 계정이라 프롬프트 캐시가 없으므로 첫 질문은 지금까지의 대화 전체를 새 계정 한도로 다시 읽는다.
- 원래 계정에는 바꾸기 직전까지의 기록이 남는다. 에이전트 기록 목록에는 두 계정에 같은 대화가 하나씩 보인다 (키는 `claude:<계정>:<세션>` 으로 다르다).
- 계정마다 쓸 수 있는 모델이 다르면 Claude 가 시작할 때 모델을 바꿀 수 있다.

## 쓰지 않은 방법

- 지금 Claude 에서 `/login` 으로 계정 바꾸기: 그 계정 폴더의 로그인 정보 자체가 바뀌어, 같은 계정을 쓰는 다른 칸까지 모두 바뀐다. 계정 프로필을 나눈 의미가 없어진다.

## 구현 전 실측 (Claude Code 2.1.332)

- 기본 계정에서 `claude -p --session-id <ID>` 로 "PELICAN-42 를 기억해" 대화를 만들었다. 기록(`<ID>.jsonl`)을 업무 계정 폴더의 같은 `projects/<폴더>/` 로 복사하고, `CLAUDE_CONFIG_DIR=<업무 계정>` 으로 `claude -p --resume <ID>` 에 기억한 단어를 물었다. 답은 `PELICAN-42` 였다.
- 이어 쓴 내용은 복사본에만 붙었고(47줄 → 73줄), 원본은 47줄 그대로였다.
- 프로젝트 폴더에는 세션과 무관한 `memory/` 가 있을 수 있어, 세션 파일과 같은 이름의 세션 폴더만 복사한다.

## 구현

- main: `src/agentChat/claudeTranscriptCopy.js`(복사·경로 검사·기존 파일 보관), `src/agentChat/claudeAccountSwitch.js`(셸·계정·상태 검사 후 복사, `replacementFor` 로 열기), `main.js` 의 `claude-profile-switch-in-place`(본창 주 프레임·잠금 해제 확인, 역할 이름 옮기기).
- 화면: `ClaudeProfileMenu.tsx`(계정마다 `이 대화를 이어서`·`새 세션`), `lib/claudeAccountContinue.ts`, `lib/agentSessionDrop.ts` 의 `swapPaneShell`(기록 끌어 놓기와 공용), `App.tsx`.
- 시험: 단위 23개(`claudeTranscriptCopy.test.js` 11, `claudeAccountSwitch.test.js` 12), 화면 시험 `local-agent-chat` 의 계정 절에 5개. 가짜 Claude 는 `<id>-hook-session` 으로 훅의 세션 ID 를 정할 수 있다.

## 남은 것

- 옛 에이전트에 온 안 읽은 메시지는 새 에이전트로 옮기지 않는다 (기록 끌어 놓기도 같다).
- 복사는 main 에서 동기로 한다. 아주 큰 기록(수백 MB)이면 그동안 창이 잠깐 멈출 수 있다.

## 시험 목록

- main: 다른 셸의 세션·없는 계정·작업 중·잠김·본창 아님 거부, 경로가 계정 루트 밖이거나 링크면 거부, 기존 대상 파일 보관, 복사 실패 시 칸을 바꾸지 않음.
- 화면 시험(가짜 Claude): 메뉴의 `이 대화 이어 가기` → 같은 칸에 새 셸, `--resume <세션>` 과 대상 `CLAUDE_CONFIG_DIR` 로 실행, 옛 셸 닫힘, 칸 배치 유지.
