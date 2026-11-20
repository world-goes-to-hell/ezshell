# 사용량 줄에서 에이전트 모델·노력 수준 바꾸기

작성: 2026-11-20. 상태: 완료 (2026-11-20). 규모: 중간 (에이전트 터미널에 키를 보내는 부분은 보안 경계에 준해 테스트 먼저).

## 배경

로컬 터미널 칸 아래 사용량 줄(`AgentPaneUsage`)에 모델과 노력 수준이 보인다. 사용자가 그것을 눌러 바로 바꾸고 싶어 한다 (2026-11-20).

## CLI 조사 (이 PC, Claude Code 와 Codex 0.170.0 을 pty 로 띄워 확인)

- 둘 다 인자로 바꾸는 명령이 없고 고르는 화면으로만 바꾼다.
- Claude: `/model` 은 번호 목록(`❯` 가 선택, `✔` 가 지금 값, `▸ More models` 는 번호 없음)과 `● High effort ←/→ to adjust` 줄. `/effort` 는 `low medium high xhigh max` 막대와 `▲` 표시. 두 화면 모두 `Enter` 는 새 세션 기본값으로 저장, `s` 는 이 세션에만.
- Codex: `/model` 한 화면 "Select Model and Effort"(`›` 가 선택, `(current)` 가 지금 값, 8개 넘으면 `↓`). 모델을 고르면 "Select Reasoning Level for <모델>"(`(current)`, `(default)`, `More reasoning…`)이 이어지고 `enter default · s session · esc back`.
- 번호 키는 바로 적용되는데 기본값 저장인지 가릴 수 없어서 쓰지 않는다.

## 결정

- 사용량 줄의 모델 이름을 누르면 모델 메뉴, 노력 수준을 누르면 노력 수준 메뉴.
- 열기: main 이 채팅 보내기와 같은 `submitText` 로 `/model`(Claude 노력 수준은 `/effort`)을 넣고, 그 화면이 뜨면 선택지를 읽어 창에 준다. Codex 노력 수준은 `/model` 에서 지금 모델을 Enter 로 고른 뒤 나오는 목록이다.
- 고르기: 화살표로 선택을 옮기며 키마다 화면이 바뀐 것을 확인하고(닫힌 고리), 마지막은 항상 `s`(이 세션에만). Codex 모델은 Enter 뒤 노력 수준 목록에서 지금 노력 수준(없으면 같은 이름, 그것도 없으면 기본)을 골라 `s`.
- 취소(메뉴를 닫음, 60초 동안 고르지 않음): 화면이 닫힐 때까지 Esc (Codex 노력 수준 목록은 두 번).
- 보이는 선택지만 다룬다: 번호 없는 `More models`, `More reasoning…`, 스크롤해야 보이는 Codex 모델은 1단계에서 뺀다.

## 바꾸면 안 되는 것 (보안)

- 키(화살표, Enter, `s`, Esc)는 그 칸의 화면이 지금도 그 고르는 화면일 때만 보낸다. 에이전트가 끝나 셸로 돌아갔는데 `s`·Enter 가 셸로 가면 안 된다.
- 열기는 에이전트가 쉬는 중(작업 중·확인 대기·시작 중이 아님)이고 입력칸이 비었을 때만. 고르는 동안은 메시지 알림 붙여 넣기와 채팅 보내기를 막는다 (`agentInboxWake` 의 `setHeld`).
- 창은 셸 id, 열기 종류, 받은 토큰, 고른 번호만 보낸다. main 은 고를 때 화면의 선택지가 연 때와 같은지 다시 본다.
- 사용자의 기본값을 바꾸지 않는다 (`Enter` 로 저장하는 단계 없음, Codex 모델 목록의 Enter 는 다음 화면으로 넘어가는 것).

## 파일

- 새 `src/ipc/agentPicker.js`(+test): 화면 읽기(`readNumberedPicker`, `readClaudeEffort`, `readClaudeModelEffort`)와 진행(`createAgentPicker`: `open(what)`, `choose(token, index)`, `cancel(token)`).
- `src/ipc/agentInboxWake.js`: `screenLines()`, `cursorKeys()`, `setHeld(value)`.
- `src/localShell.js`: 셸마다 picker, `pickerOpen`·`pickerChoose`·`pickerCancel`.
- IPC `agent-picker-open|choose|cancel` (본창·잠금 해제 상태만), `src/preload.js`, `types/index.ts`.
- 화면: `AgentUsage/AgentUsageMeters.tsx` 의 모델·노력 수준을 버튼으로, 새 `AgentUsage/AgentPickerMenu.tsx`(Radix DropdownMenu).

## 확인

- 단위: 화면 읽기(Claude 모델·노력 수준, Codex 모델·노력 수준, 선택 표시, 빠지는 항목), 진행(가짜 화면): 열기 실패(입력칸 없음, 화면이 안 뜸), 화살표 횟수와 확인, 화면이 바뀌면 키를 멈춤, `s` 로 끝냄, 취소의 Esc, 시간 초과.
- 실제 CLI 를 pty 로 띄운 시험 스크립트로 Claude·Codex 각각 바꾸기·취소.
- 앱 한 번 (임시 프로필, 실제 에이전트).

## 진행

- [x] 화면 읽기 + 진행 + 테스트 (`agentPicker.test.js` 18개, `agentInboxWake.test.js` 에 1개)
- [x] inbox·localShell·IPC·preload
- [x] 화면 (`AgentPickerMenu.tsx`, 스타일은 DB 메뉴를 본뜸)
- [x] 실제 CLI 시험: Claude 모델(Sonnet·Haiku·Opus)·노력 수준(low·high·max)·취소, Codex 모델·노력 수준·취소. 모두 "this session only" 로 적용되고 `~/.claude/settings.json`·`~/.codex/config.toml` 수정 시각이 그대로.
- [x] 앱 확인: 빌드한 앱(임시 프로필)의 실제 Codex 칸에서 모델을 메뉴로 바꿈, 노력 수준 메뉴를 닫으면 CLI 화면도 닫힘. CLAUDE.md.

## 추가 (2026-11-20 사용자 요청·보고)

- 앱에서 Codex 선택 화면이 3초 넘게 걸려 그려져 "뜨지 않았습니다" 뒤 화면이 남았다 → 8초까지 기다리고, 늦게 뜬 화면도 닫는다. 고르는 동안 채팅 보기의 질문 카드에 나오지 않게 했다.
- 칸이 낮으면 목록이 스크롤된다 → 선택지를 번호로 알아보고, 스크롤 목록은 끝까지 모은다. 목록이 바뀔 때는 화면이 멎은 뒤 읽는다.
- 바꿔도 Codex 사용량 줄이 다음 차례까지 예전 값 → CLI 의 확인 문구를 읽어 바로 반영.
- 열 때마다 몇 초 → 목록을 기억해 바로 보여 주고(IPC `list`/`apply` 로 바꿈), 메뉴 머리줄에 새로고침 버튼.
- 포커스 없는 Claude(채팅 보기)의 입력칸을 찾지 못함 → 커서 없는 한 줄 입력칸도 알아본다 (실제 앱 재현은 이 PC 의 Claude 훅이 시험 환경에서 끝나지 않아 못 함).

## 구현 중 알게 된 것

- Claude 의 노력 수준 `max` 는 기본값이 될 수 없어서, 그 칸에서는 아래 안내가 `Enter to use this session only` 로 바뀐다. 그래서 마지막 키는 고정 `s` 가 아니라 화면 안내가 "이 세션에만"이라고 이름 붙인 키다 (`SESSION_KEYS`). 안내가 없으면 아무 키도 누르지 않는다.
- 선택 화면이 닫힌 직후 Codex 는 입력칸을 다시 그리는 중이라, 바로 다시 열면 입력칸이 비어 있지 않은 것으로 보였다. 닫힌 뒤 0.4초(`settleMs`)가 지나야 다음 열기·메시지 알림을 받는다.
- Codex 는 첫 메시지 전에는 기록 파일이 없어 사용량 줄(과 이 메뉴)이 뜨지 않는다. Codex 의 사용량 줄 모델 이름은 다음 응답 뒤에 바뀐다 (기록 파일의 `turn_context`).
