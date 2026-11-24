# 에이전트 상태와 작업 중 메시지를 CLI 의 공식 신호로 받기 (채팅 모드 근본 개선 1단계)

2026-11-24 설계. 이 문서에는 코드 변경이 없다.

**목표.** 사용자 결정에 따른 작업이다. 화면을 읽어 짐작하는 구조 때문에 채팅·알림 버그가 반복되므로, 1단계로 두 가지를 공식 신호로 바꾼다.
- A) 상태(working / idle / blocked / 질문 대화 상자)를 Claude Code 훅과 Codex 훅으로 받는다.
- B) 작업 중에 온 메시지는 입력칸에 `BUSY_PROMPT` 를 붙이지 않는다. 차례가 끝날 때 Stop 훅으로 이어 가게 한다.

**지금의 상태 판단 (`src/localShell.js` 의 `agentStatus`).** 다음을 모두 섞어서 짐작한다.
- 화면 판독(`screenApproval`).
- 프로그램 상태 보고 OSC 7501(`reportedStatus`). Claude Code 는 보내지 않는다.
- 창 제목의 스피너, OSC 9;4 진행 표시(`titleStatus`).
- Codex 의 PTY 입력 추적(`codexInput`)과 rollout 보정(`codexActivity`, 커밋 6886e60).
- 깨우기(`src/ipc/agentInboxWake.js`)는 이 상태가 `unknown` 이면 "빈 입력칸이 1.5초 그대로인가"(`quietMs`)로 다시 짐작한다.

## 1. 확인한 사실과 확인하지 못한 것

표시: **✔실측** = 이 PC 의 실제 CLI 로 확인. **✔문서** = 공식 문서나 태그 소스로 확인(링크). **✗미확인** = 근거를 찾지 못했거나 시험하지 못함.

이 PC 의 버전은 `claude 2.1.331`, `codex-cli 0.171.0` 이다.

실측 방법:
- 실제 `~/.claude`·`~/.codex` 를 건드리지 않도록 `CLAUDE_CONFIG_DIR`·`CODEX_HOME` 을 임시 폴더로 두고 `-p`·`exec` 로 실행했다.
- 그 폴더에는 로그인 정보가 없어 API 호출은 실패한다. 그래서 차례 시작까지만 관찰했다.
- 시험 스크립트는 `scratchpad/hookprobe/` (`probe.js` 가 인자와 stdin JSON 의 키만 적음).

### Claude Code (2.1.331)

| 사실 | 근거 |
|---|---|
| `--settings <파일>` 로 넣은 훅이 실행된다 (SessionStart, UserPromptSubmit, SessionEnd, StopFailure 를 받음) | ✔실측 |
| `--settings` 의 훅은 사용자 설정의 훅을 **덮어쓰지 않고 함께** 실행된다 (사용자 `settings.json` 의 SessionStart 와 `--settings` 의 SessionStart 가 둘 다 실행됨) | ✔실측 |
| Windows 에서 명령 훅은 Git Bash 로 실행된다 (`SHELL=…\Git\bin\bash.exe`, `MSYSTEM=MINGW64`). Git Bash 가 없으면 PowerShell 로 떨어진다 | ✔실측 / ✔문서 (hooks, "Windows") |
| 지금 쓰는 상태 줄 명령도 같은 POSIX 문법(`ELECTRON_RUN_AS_NODE=1 "$EZSHELL_CLI_EXE" …`, `agentMessages.js:602`)으로 돌고 있다 | 코드 |
| 공통 입력: `session_id`, `transcript_path`, `cwd`, `hook_event_name`. 차례 안의 이벤트에는 `prompt_id`, `permission_mode` 등이 더 있다 | ✔실측 + ✔문서 |
| **UserPromptSubmit 입력의 `prompt` 는 사용자가 쓴 글 원문이다.** StopFailure·Stop 의 `last_assistant_message` 는 답변 원문이다 | ✔실측 (`prompt: "say ok"`, StopFailure 의 `last_assistant_message`) |
| 이벤트: SessionStart(`source`: startup/resume/clear/compact/fork), UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, PermissionDenied, Notification, Stop, StopFailure(API 오류로 끝난 차례), SubagentStart/Stop, PreCompact/PostCompact, Elicitation, SessionEnd 외 | ✔문서 https://code.claude.com/docs/en/hooks. StopFailure·SessionEnd 는 ✔실측 |
| Notification 의 `notification_type`: `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input`, `agent_completed` 외 | ✔문서 |
| PreToolUse 매처가 `AskUserQuestion` 을 내장 도구 이름으로 받는다 (예시는 없음) | ✔문서 (매처 설명) |
| Stop 의 `{"decision":"block","reason":"…"}`: 차례가 이어지고 Claude 는 `reason` 을 다음 지시로 받는다. 무한 반복을 막는 `stop_hook_active` 가 입력에 있고, 연속 이어 가기는 8번으로 제한된다 | ✔문서 |
| 종료 코드: 0 성공(stdout JSON 해석), 2 막기(이벤트마다 뜻이 다름), 그 밖은 막지 않는 오류 | ✔문서 |
| 기본 시간 제한은 명령 훅 600초, SessionEnd 1.5초. 같은 이벤트의 훅은 병렬로 돈다. `async: true` 로 기다리지 않게 할 수 있다 | ✔문서 |
| 훅은 부모 환경을 물려받는다 (그래서 `EZSHELL_AGENT_TOKEN`·`EZSHELL_SHELL_TOKEN`·`EZSHELL_AGENT_PIPE` 가 닿는다) | ✔문서 (상태 줄이 이미 그렇게 동작) |
| 대화형 세션은 폴더를 신뢰하기 전까지 모든 설정 파일의 훅을 보류한다 (`-p` 는 신뢰로 간주). `--settings` 훅도 보류된다 | ✔문서 + ✔실측 (T0 ⑤) |
| 설정 파일을 고치면 다시 읽는다 (재시작 없이) | ✔문서 |
| **Stop 의 block 이 대화형 2.1.331 에서 차례를 잇는다.** `reason` 은 `isMeta` 사용자 줄 `Stop hook feedback:\n…`·`hook_blocking_error` 첨부·`stop_hook_summary` 로 남는다 | ✔실측 (T0 ①) |
| Esc 로 멈춘 차례에는 Stop 이 오지 않는다 (StopFailure·PostToolUse 도 없음) | ✔실측 (T0 ②) |
| PostToolUse 의 `hookSpecificOutput.additionalContext` 로 차례 중간에 글을 넣을 수 있는지 | ✗미확인 (문서는 additionalContext 를 일반 필드로 설명, PostToolUse 예시 없음) |
| `idle_prompt` 알림이 언제(몇 초 뒤) 오는지 | ✗미확인 |

### Codex (0.171.0)

| 사실 | 근거 |
|---|---|
| 훅 기능(`hooks`)이 Stable 이고 기본으로 켜져 있다 (0.160 부터) | ✔실측(`codex features list`) + ✔문서 `codex-rs/features/src/lib.rs` (tag `rust-v0.171.0`) |
| 이벤트: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PreCompact/PostCompact, SubagentStart/Stop, **Stop**, **Interrupt**, PreModelRequest/PostModelRequest. **Notification 과 질문 대기(`request_user_input`) 이벤트는 없다** | ✔문서 https://learn.chatgpt.com/docs/hooks, `codex-rs/protocol/src/protocol.rs#L1835-L1850` |
| 입력: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, 차례 이벤트에 `turn_id`·`permission_mode`. UserPromptSubmit 에 `prompt`(원문), Stop 에 `stop_hook_active`·`last_assistant_message` | ✔문서 `codex-rs/hooks/src/schema.rs`. SessionStart·UserPromptSubmit 의 키는 ✔실측 |
| Stop 의 `decision:"block"` + `reason`: 차례가 이어지고 `reason` 이 새 프롬프트가 된다 | ✔문서 `codex-rs/core/src/session/turn.rs#L847-L866` |
| `-c hooks.<Event>=[…]` 로 실행마다 훅을 넣을 수 있고, 다른 층(사용자·프로젝트)의 훅과 **합쳐진다** | ✔실측(설정이 읽힘) + ✔문서 `discovery.rs#L157-L215` |
| **신뢰하지 않은 훅은 실행하지 않는다.** `-c` 로 넣은 훅도 신뢰 대상이다. 신뢰 기록은 사용자 `config.toml` 의 `[hooks.state.'<출처>:<이벤트>:<묶음>:<번호>'] trusted_hash`. TUI 는 시작할 때 "Review hooks / Trust all and continue / Continue without trusting" 을 묻는다 | ✔실측(`-c` 훅이 신뢰 없이 실행되지 않음) + ✔문서 `discovery.rs#L1011-L1052`, `tui/src/startup_hooks_review.rs` |
| `--dangerously-bypass-hook-trust` 를 붙이면 실행되지만, **사용자·프로젝트의 신뢰하지 않은 훅까지 모두** 풀린다 | ✔실측(이 옵션으로 SessionStart·UserPromptSubmit 실행) + ✔문서 `discovery.rs#L157-L215` |
| 훅 명령은 세션의 셸로 실행된다 (PowerShell 이면 `-NoProfile -Command`). Windows 전용 명령 `command_windows` 를 둘 수 있다. 환경은 세션 시작 때의 스냅숏 | ✔문서 `core/src/session/mod.rs#L6193-L6225`, `hooks/src/registry.rs#L84` |
| `notify`: 차례가 끝날 때(`agent-turn-complete`)만, JSON 을 마지막 인자로, 셸 없이 띄우고 기다리지 않는다. 내용에 `input-messages`·`last-assistant-message` 원문이 있다. `-c notify=` 는 사용자의 `notify` 를 **통째로 바꾼다** | ✔문서 `hooks/src/legacy_notify.rs`, `config/src/merge.rs#L56-L60` |
| TUI 알림(`tui.notifications`, OSC 9)은 사람이 읽는 문구뿐이고 종류 필드가 없다 | ✔문서 `tui/src/chatwidget/notifications.rs` |
| `-c hooks.state…trusted_hash` 로 신뢰를 함께 넘길 수 있는지 | ✗미확인 (에이전트 추정만 있음. 넘길 수 있더라도 아래 결정 1 참고) |
| Stop block 이 TUI 에서 차례를 잇는 모습, `reason` 이 rollout 에 남는 모양 | ✗미확인 (로그인 필요) |

### T0 실측 결과 (2026-11-24, 로그인된 실제 CLI)

**방법**
- Claude:
  - 실제 계정과 `~/.claude` 를 쓰고, 설정 파일은 고치지 않았다. 훅은 `--settings` 로만 넣었다.
  - `--model haiku`, `--strict-mcp-config` 로 띄웠고, ezShell 환경 변수는 뺐다.
  - 임시 작업 폴더에서 node-pty 로 대화형 TUI 를 조작하며 훅 로그·창 제목·화면을 시각과 함께 기록했다. 스크립트는 `scratchpad/t0/`.
- Codex:
  - 실제 홈에서 `-c hooks.*` 를 넣어 신뢰 화면까지만 보고, 아무것도 고르지 않고 Ctrl+C 로 나왔다.
  - 그 전후로 `~/.codex/config.toml`·`hooks.json` 의 해시가 같다.
  - 승인 뒤 동작은 볼 수 없었다: 임시 `CODEX_HOME` 에 인증 파일을 복사하는 것이 이 세션의 권한 판정에서 거부됐다 (아래 "남은 미확인").

| # | 질문 | 결과 | 근거 (시각은 시험 시작부터 초) |
|---|---|---|---|
| ① | 대화형 Stop block 이 차례를 잇는가 | **예** | UserPromptSubmit → Stop(`stop_hook_active:false`) 에 block → 화면에 `BANANA` → Stop(`stop_hook_active:true`). 기록에는 `isMeta` 사용자 줄 `Stop hook feedback:\n<문구>`, `attachment.type:"hook_blocking_error"`, `system/stop_hook_summary` 가 남는다. 모델에는 "The text below is the output of a hook, not a message from the user." 로 감싸져 간다 |
| ② | Esc 로 멈춘 차례에 Stop 이 오는가 | **아니오** | 포그라운드 Bash(ping) 중 Esc(64.9) 뒤 10초 동안 Stop·StopFailure·PostToolUse 모두 없음. 창 제목은 Esc 직후(65.0) `✳`(idle) |
| ⑤ | 폴더 신뢰 전 `--settings` 훅이 도는가 | **아니오** | 새 폴더의 신뢰 화면이 떠 있는 동안 훅 0개. "Yes, I trust this folder" 를 고른 뒤에 SessionStart. 신뢰 화면의 기본 선택은 "No, exit" |
| ⑦ | 훅 기동 비용 | **작음** | Electron 을 node 로 띄워 stdin JSON 을 읽고 끝내는 데 직접 실행 약 60ms, Git Bash 를 거치면 약 110ms, RSS 37MB(잠깐). 7개 동시: 전체 117ms(직접)·175ms(Git Bash) |
| ⑧ | 긴 도구·하위 에이전트·권한 대기 중 창 제목 | 긴 도구·하위 에이전트: **스피너 계속**. 권한 대기: **`✳`(idle 모양)** | 포그라운드 ping 22초 동안 `◐/◑` 가 1초마다 바뀜. 하위 에이전트(Agent 도구, SubagentStart) 동안도 스피너. 권한 확인 질문이 뜨자 제목이 `✳` 로 바뀜(32.3). PermissionRequest 는 질문이 뜬 즉시(32.4), Notification `permission_prompt` 는 약 6초 뒤(38.5), 답한 뒤 PostToolUse(38.7) |
| ⑨ | 사용자 대기열이 있을 때 Stop 이 오는가 | **중간에는 오지 않음** | 도구 실행 중에 친 다음 질문은 **같은 `prompt_id`** 로 UserPromptSubmit 을 한 번 더 일으키고 같은 차례에 흡수됨. Stop 은 차례 끝에 한 번 |

**그 밖에 본 것**
- Claude 가 스스로 시작한 차례에도 UserPromptSubmit 이 온다. 예: 백그라운드 작업이 끝났을 때 결과를 읽는 차례.
- 눈에 보이는 하위 에이전트가 없어도 Stop 직후에 SubagentStop 이 온다 (내부 에이전트로 보임). 상태 판단에서는 무시한다.
- 사용자 전역 설정에서 허용된 도구(이 PC 에서는 Bash `sleep`·`ping`, Write)는 권한 질문 없이 실행된다. 권한 대기 시험은 `--settings` 의 `permissions.ask: ["Write"]` 로 만들었다.

**Codex 신뢰 화면 (실측)**
- 시작하면 업데이트 안내 뒤 다음 화면이 뜬다. 승인 전에는 우리 훅이 하나도 실행되지 않았다.

```
Hooks need review
3 hooks are new or changed.
Hooks can run outside the sandbox after you trust them.
› 1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)
enter confirm · esc skip
```

- "Review hooks" 는 이벤트별 표다 (Event / Installed / Active / Review / Description). 아래에 `t trust all · enter review · esc close` 가 있다.
- 이 PC 에서는 Orca 의 훅이 이미 신뢰된 상태라, SessionStart·UserPromptSubmit 의 Installed 2, Active 1, Review 1 로 보였다. 우리 훅만 검토 대상이다.

### 앱으로 한 실측 (2026-11-25, 92e4b8b 빌드, 실제 계정)

**방법**
- `npm run build` 뒤 Electron 을 `--user-data-dir=<임시 프로필>` 로 따로 띄웠다. 설치본(2.33.0)과 단일 실행 잠금·메시지 연결 파일이 겹치지 않는다.
- 빈 Git 폴더에서 Claude Code 2.1.331 과 Codex 0.171.0 을 앱이 띄우고, CDP 로 입력하며 툴팁의 상태를 0.5초마다 읽었다.
- Codex 훅 신뢰와 Claude 폴더 신뢰는 사용자가 직접 눌렀다.
- 주의: Claude Code 의 셸에서 앱을 띄우면 `NO_COLOR=1` 이 넘어가, 그 안의 Claude 가 색 없이 돈다. 시험 창을 띄울 때는 `NO_COLOR` 도 지운다 (아래 "찾은 것" 3).

| 항목 | 결과 |
|---|---|
| Codex 신뢰 | 검토 표에서 `t`(trust all)로 우리 훅 10개를 승인했다. 사용자의 기존 훅은 이미 Active 라 새로 신뢰되지 않았다. 첫 신호(UserPromptSubmit)에 `codex-hook-mode` 가 `approved` 가 됐다 |
| 신뢰 기록 | 사용자 `~/.codex/config.toml` 의 `[hooks.state.'C:\<session-flags>\config.toml:<이벤트>:0:0'] trusted_hash`. 설치 경로가 키에 없다 |
| 다음 실행 | 앱을 다시 띄워도 다시 묻지 않았다 |
| 해시에 드는 것 | `async` 를 바꾸면 그 훅만 다시 묻고(`1 hook is new or changed`), `timeout` 만 바꾼 훅은 묻지 않았다 |
| Codex 상태 | 작업 중·쉼 모두 `Codex 가 알려 준 신호로 판단`. Esc 를 누르면 1초 안에 쉼 (Interrupt) |
| Codex Stop block | 45초 명령 중에 온 메시지: 입력칸에 아무것도 넣지 않았다. 명령이 끝나자 `Blocked by hook — New ezShell message: …` 가 뜨고 같은 차례에서 `read_inbox` → `reply_to_message` |
| Claude 상태 | ezShell 이 띄운 Claude 는 폴더 신뢰 직후 SessionStart 로 신호 판단이 됐다. 선택지 질문(AskUserQuestion) 동안 `응답 필요`, 답한 뒤 쉼 |
| Claude Stop block | 35초 포그라운드 명령 중에 온 메시지: 입력칸에 넣지 않았다. 명령이 끝나자 `Ran 7 stop hooks · Stop hook reported a problem · New ezShell message: …` 뒤 같은 차례에서 읽고 답했다 (사용자의 다른 Stop 훅과 함께 돈다) |
| 쉴 때 메시지 | Claude·Codex 모두 입력칸의 `PROMPT` 로 깨어나 답했다. Claude Code 는 포그라운드 `sleep 40` 을 막고 백그라운드로 돌린 뒤 차례를 끝내므로, 그 사이 온 메시지는 쉴 때 경로로 갔다 |
| 직접 친 `claude` | PowerShell 함수가 `--settings` 를 붙여 훅이 온다. 다만 첫 질문 전에는 화면 판단이다 (아래 "찾은 것" 2) |

**찾은 것**
1. Codex 0.171 은 SessionEnd·Interrupt 의 `timeout` 을 3초로 줄이고 SessionEnd 를 항상 동기로 돌리며, 그 설정을 줄 때마다 시작 경고(`6 warnings` 중 3개)를 띄웠다. → 2026-11-25 에 값을 3초·동기로 맞췄다 (`codexHookLaunch.js`). 바꾼 뒤 검토 표의 Issues 가 사라졌고, 이미 승인한 이 PC 는 SessionEnd 하나만 다시 묻는다.
2. 셸에 직접 친 Claude 의 SessionStart 는 메시지 MCP 가 그 셸에 묶이기 전에 와서 버려진다 (`agentMessages.respond` 의 셸 토큰 경로에서 같은 셸·종류의 에이전트가 아직 없음). 첫 질문부터는 훅 판단이고, 그 전에는 화면 판단이 쉼을 맞게 보여 준다. 고치려면 셸별로 짧게(수 초) 받아 두었다가 묶일 때 넘겨야 한다. 이득이 툴팁 문구뿐이라 미뤘다.
3. `NO_COLOR` 환경에서는 Claude 의 다음 질문 제안이 흐림 속성 없이 그려져, 깨우기가 사용자가 쓰던 글로 보고 `PROMPT` 를 넣지 않는다 (훅 변경 전부터 있던 문제). 커서가 글 앞에 있는 모양으로 가를 수 있지만 사용자가 Home 을 누른 초안과 겹친다.
4. Claude 폴더 신뢰 화면 동안(훅이 돌기 전) 화면 판단이 `쉼` 이다. 신뢰 화면을 확인 대기로 읽지 못한다 (예전부터).
5. Claude 의 block 표시는 노란 `Stop hook reported a problem` 이다. Claude 의 고정 문구라 바꿀 수 없고, 아래 줄의 `reason` 만 우리 것이다.
6. 이미 승인한 사용자도, 훅 정의가 바뀌어 다시 묻는 화면에서 `3`/Esc 를 누르면 `observeCodexHookReview` 의 decline 으로 `codex-hook-mode` 가 `disabled` 가 되어 Codex 훅 전체가 빠진다. 2.34.0 이 첫 배포라 지금 해당하는 사용자는 없다. 다음에 훅 정의를 바꾸기 전에 정할 것 (§6 남은 결정 7).

**아직 실측하지 않은 것**
- 하위 에이전트가 권한을 묻는 동안의 상태, 자동 모드가 아닐 때 Claude 권한 질문(Notification `permission_prompt`), Codex PermissionRequest (이번 Codex 는 명령을 묻지 않고 실행했다).
- 채팅 보기에서의 같은 시나리오 (이번은 모두 터미널 보기).

### 이 PC 의 상황

- 사용자 전역 설정에 Orca 가 등록한 훅이 이미 있다. `~/.claude/settings.json` 의 hooks 와 `~/.codex/hooks.json` 이다. 둘 다 Orca 의 환경 변수가 없으면 바로 끝나는 방식이다. Codex 훅은 `config.toml` 에 신뢰 해시까지 기록돼 있다.
- 우리 훅은 이것들과 함께 돈다(병합). 서로 방해하지 않는다.
- Orca 의 방식(전역 등록 + 환경 변수로 걸러냄)은 참고만 한다. 우리는 사용자 전역 설정을 쓰지 않는다.

## 2. 설계

### 2.1 신호 경로

```
CLI 훅 (Claude: --settings 파일 / Codex: -c hooks.*)
  → 훅 명령: ezShell 실행 파일을 node 로 (ELECTRON_RUN_AS_NODE=1) src/ipc/agentHookReport.js <cli> 
  → stdin JSON 을 읽어 "이벤트 낱말 + 세션 id" 만 남김
  → 에이전트 파이프(EZSHELL_AGENT_PIPE)로 rpc { method: 'agent-event', event, sessionId?, tool? }
       토큰: EZSHELL_AGENT_TOKEN (ezShell 이 띄운 에이전트) 또는 shellToken (셸에 직접 친 에이전트)
  → main: agentMessages.respond 가 토큰 → 에이전트를 찾고 (usage 와 같은 규칙)
       → localShell 의 그 셸 entry 에 hookState 를 기록 → agentStatus 가 우선 사용 → reportStatus
  ← (Stop 만) main 의 답 { block: '…' } 이 있으면 stdout 에 {"decision":"block","reason":"…"}
```

- 통로는 상태 줄 사용량 보고와 같다 (`agentUsageReport.js`, `agentMessages.js:247-278`). 토큰 검증, 잠금 중 거부, 셸 토큰 → 셸의 활성 에이전트 찾기를 그대로 다시 쓴다.
- 훅 스크립트의 원칙:
  - 무엇이 실패해도 종료 코드 0, 출력 없음이다(Stop 의 block 만 예외).
  - 1.5초 안에 끝낸다.
  - **stdin 은 끝까지 읽어 비운다.** 하지만 원문은 모으지 않는다. 바이트 상한을 두고 자르면 Stop 의 `last_assistant_message`(긴 답변)에서 JSON 이 깨져 이벤트를 잃는다. 또 CLI 가 파이프 쓰기에서 기다릴 수 있다.
    - 최상위 객체를 스트림으로 훑어 허용 목록 키(`hook_event_name`, `session_id`, `prompt_id`, `tool_use_id`, `tool_name`, `notification_type`, `stop_hook_active`, `source`)의 짧은 값만 꺼낸다. 문자열은 100자 이하, 불리언 그대로다.
    - 나머지 키의 값은 저장하지 않고 건너뛴다. 원문은 메모리에도 남기지 않는다.
    - 읽기는 1초 시간 상한 안에서 한다. 넘으면 그때까지 꺼낸 값으로 처리한다.
  - 훅 스크립트가 시작한 시각(`startedAt`, ms)을 함께 보낸다 (아래 B1 의 보조 정렬).

**앱으로 보내는 것 (허용 목록)**

| 필드 | 값 |
|---|---|
| `event` | 아래 표의 이벤트 이름 중 하나 |
| `sessionId` | UUID 형식만 |
| `promptId` | 차례 짝 맞추기용 (`prompt_id`, Codex 는 `turn_id`, 형식 검사) |
| `tool` | `AskUserQuestion` 인지 여부, 그리고 권한·질문 대화 상자를 닫는 짝을 맞출 `tool_use_id` (형식 검사) |
| `notification` | `notification_type` 낱말 (허용 목록) |
| `startedAt` | 훅 스크립트 시작 시각 (숫자) |

**보내지 않는 것**
- `prompt`, `last_assistant_message`, `tool_input`, `transcript_path`, `cwd`, `message`

### 2.2 이벤트 → 상태

| 이벤트 | Claude | Codex | 상태 |
|---|---|---|---|
| SessionStart | ✔ | ✔ | `idle` (+ 세션 id: 채팅 기록·사용량 연결의 확실한 출처). 열린 차례 중에는 상태 그대로: 아래 우선순위 2·7 참고 |
| UserPromptSubmit | ✔ | ✔ | `working` |
| PreToolUse `AskUserQuestion` | ✔ | (없음) | `blocked` (질문) |
| PermissionRequest | ✔ | ✔ | `blocked` (권한) |
| Notification `permission_prompt` / `elicitation_dialog` | ✔ | (없음) | `blocked` |
| PostToolUse / PostToolUseFailure / PermissionDenied (같은 `tool_use_id`) | ✔ | ✔ (PostToolUse) | `working` (대화 상자가 닫힘) |
| PreCompact | ✔ | ✔ | `working` (압축 중) |
| Stop | ✔ | ✔ | `idle` (우리가 block 한 Stop 은 working: 아래 우선순위 2·7 참고) |
| StopFailure | ✔ | (없음) | `idle` (오류 표시는 기존 기록에서) |
| Interrupt | (없음) | ✔ | `idle` |
| Notification `idle_prompt` | ✔ | (없음) | `idle` (보강) |
| SessionEnd | ✔ | ✔ | 에이전트 끝 (셸 종료 감시와 같은 처리) |
| SubagentStart/Stop | 무시 | 무시 | 하위 에이전트는 부모 차례 안 |

**우선순위 (`agentStatus` 를 고치는 방향)**

1. **훅 있음의 시작 (B2).** 어떤 훅 이벤트든 처음 받으면 그 에이전트에 `hookState` 를 켠다. SessionStart 만 기다리지 않는다: 되살린 셸, 실행 중에 설정을 다시 읽기 시작한 경우가 있다.
   - 켠 뒤에도 상태 이벤트(UserPromptSubmit·Stop·PermissionRequest 등)가 하나 올 때까지는 상태를 기존 방식으로 둔다.
   - 그 뒤로는 훅 상태가 기준이다.

2. **차례(`promptId`)를 열고 닫기 (B1).** 상태 보고 훅은 `async` 라 도착 순서가 바뀔 수 있다. 그래서 차례마다 열림·닫힘을 기록한다.
   - **여는 이벤트:** UserPromptSubmit 이 `promptId`(Claude `prompt_id`, Codex `turn_id`)를 연다.
     - 같은 `promptId` 의 UserPromptSubmit 이 여러 번 오는 것은 정상이다 (T0 ⑨: 작업 중에 친 질문이 같은 차례에 흡수됨). 새 차례로 치지 않는다.
   - **닫는 이벤트:** Stop·StopFailure(Claude), Stop·Interrupt(Codex)가 차례를 닫는다.
     - Esc 로 끝나 Stop 이 없는 Claude 차례는 아래 3 의 (a)·(b) 가 닫는다. 닫은 시각은 그 보정을 한 시각이다.
   - **늦은 이벤트 버리기:** 닫힌 `promptId` 의 이벤트 가운데, 훅 스크립트의 `startedAt` 이 닫는 이벤트의 `startedAt`(또는 보정 시각)보다 이른 것은 모두 버린다. 늦게 도착한 PreToolUse·PostToolUse 가 idle 을 working 으로 되돌리지 않게 하기 위해서다. 닫힌 차례의 늦은 UserPromptSubmit 도 같다.
   - **우리가 block 한 Stop (규칙 3):** 우리가 `decision: block` 으로 답한 Stop 은 차례를 닫지 않는다. 그래서 상태는 `working` 그대로다. 같은 `promptId` 의 다음 Stop(`stop_hook_active: true`)이 닫는다.
   - **대화 상자:** 여는 이벤트는 PermissionRequest·PreToolUse(AskUserQuestion)·Notification `elicitation_dialog`·Elicitation 이다. PostToolUse·PostToolUseFailure·PermissionDenied 가 같은 `tool_use_id` 로 닫는다. 이미 닫힌 id 의 늦은 열림은 버린다.
   - **대화 상자를 한꺼번에 닫는 경우 (규칙 6):** 다음 때는 열린 대화 상자를 모두 닫는다:
     - Stop·StopFailure·Interrupt
     - 새 `promptId` 의 UserPromptSubmit
     - 아래 "놓친 blocked" 로 화면 판독에 돌아갈 때
     - 권한 질문을 "No" 로 거절했을 때 어떤 이벤트가 닫는지는 확인하지 못했다(✗미확인). 그래서 이 일괄 닫기에 기댄다.

3. **Claude 의 보정 (창 제목, 규칙 8: Claude 에만).** Codex 는 Interrupt 훅이 차례를 닫으므로 제목 보정을 쓰지 않는다. 승인한 Codex 에서 Esc 가 Interrupt 를 내는지는 T9 실측에서 확인한다.
   - **멈춘 working (T0 ② 로 필수가 됨).** Esc 로 멈춘 Claude 차례에는 Stop 이 오지 않는다. 그래서 훅만 보면 `working` 이 남는다. 다음 둘 중 하나면 차례를 닫고 `idle` 로 본다:
     - (a) 그 셸에 사용자 Esc 또는 Ctrl+C 가 있었고, 1초 안에 창 제목이 `✳` 가 됐다.
       - **사용자 Esc 의 정의 (규칙 7):** `localShell.write` 에 들어온 데이터가 정확히 한 글자 `\x1b` 인 경우만이다. `localShell.js` 의 `data === '\x1b'` 판정과 같다. 접두어로 보지 않으므로 방향키·포커스 보고·마우스 보고는 빠진다. Ctrl+C 는 정확히 `\x03` 이다.
       - 채팅의 `중지`(`interruptAgent`)도 사용자 Esc 로 친다.
       - 앱이 보내는 Esc 는 빼야 한다: `agentPicker` 의 화면 닫기, `claudeQuestions` 의 키, `takeBack` 의 지우기. 이 셋은 `write` 를 거치지 않거나 표시를 달아 구분한다.
       - 권한 질문 중 Esc 는 질문을 거절하는 키다. 이때는 화면에서 대화 상자가 사라진 것까지 본 뒤에 `idle` 로 한다.
     - (b) 창 제목이 3초 넘게 `✳` 이고 그동안 훅이 오지 않았다.
   - **B3 (T0 ⑧ 로 다시 정함).** 긴 도구와 하위 에이전트 동안에는 제목 스피너가 계속 돈다. 그래서 그 사이에 `✳` 가 보이면 멈춘 것이다.
     - **예외 (규칙 5):** 대화 상자가 열려 있으면 `✳` 는 그 대화 상자를 기다리는 모양이다. 이때는 `blocked` 로 두고 위 보정을 하지 않는다. 열린 대화 상자는 PermissionRequest, PreToolUse(AskUserQuestion), Notification `elicitation_dialog`, Elicitation 이다.
     - AskUserQuestion 이 떠 있는 동안의 창 제목은 T3 실측에서 확인한다.
   - **다른 훅이 block 한 Stop (규칙 4).** Orca 처럼 다른 전역 Stop 훅이 block 하면 Claude 는 계속 일한다. 우리는 그 사실을 훅으로 알 수 없다. 그래서 (b) 의 반대 보정을 둔다: Stop 을 받은 뒤 2초 넘게 제목 스피너가 돌면 `working` 으로 되돌린다. 차례는 다시 연 것으로 본다.

4. **놓친 blocked.** 훅이 `blocked` 인데 화면에 대화 상자가 없고 닫는 이벤트도 오지 않은 채 5초가 지났다. 이때는 열린 대화 상자를 모두 닫고(규칙 6) 화면 판독으로 돌아간다.

5. **훅이 아직 없는 에이전트**는 지금 방식(OSC 7501 → 창 제목·OSC 9;4 → 화면 → rollout 보정) 그대로다.

6. **10초 규칙 (B2).** 막 띄운 에이전트에만 적용한다. 띄운 뒤 10초 안에 아무 훅도 오지 않으면 그 실행은 "훅 없음"으로 보고 대체 경로로 간다.
   - 이 경우에 해당하는 것: 옛 CLI, 폴더 신뢰 전, Git Bash 없음, 훅 실패. 상태가 틀리는 것이 아니라 지금 수준으로 남는다. 그 뒤라도 훅이 오면 1 에 따라 켠다.
   - 폴더 신뢰 화면(Claude)이나 훅 검토 화면(Codex)이 떠 있는 동안은 훅이 오지 않는다(T0 ⑤·Codex 실측). 그래서 이 10초는 그 화면이 닫히고 입력칸이 처음 보인 때부터 센다.
   - Notification `permission_prompt` 는 질문이 뜬 지 몇 초 뒤에 온다(T0 ⑧, 약 6초). `blocked` 의 기준은 PermissionRequest 로 하고 Notification 은 보강으로만 쓴다.

7. **SessionStart 와 세션 바뀜 (B4, 규칙 1).**
   - 열린 `promptId` 가 있으면 SessionStart(`compact` 등)는 상태를 바꾸지 않고 세션 id 만 갱신한다. 자동 압축은 차례 중간에 일어난다.
   - 열린 차례가 없을 때의 SessionStart 는 `idle` 이다.
   - 세션 키 갱신은 `source` 가 아니라 **`session_id` 값이 실제로 바뀌었는지**로 정한다. 바뀌었으면 다음을 같은 경로로 갱신한다:
     - 채팅 기록 파일 연결 (`chats.js`)
     - 역할 저장 키 (`agentRoleStore`)
     - 사용량·한도 보고의 세션 키
   - 지금 각자 찾는 방식(Claude 상태 줄의 `session_id`, 세션 파일, Codex 감시기)은 훅이 없을 때의 대체로 남긴다.

8. **PostCompact (규칙 14).** 열린 `promptId` 가 없을 때(`/compact` 로 사용자가 부른 압축) PostCompact 는 `idle` 이다. 열린 차례가 있으면 상태를 바꾸지 않는다.

9. **잠든 셸 (E1).** 잠드는 중이거나 잠든 셸(`agentMessages.sleep` 의 `sleeping`)의 SessionEnd 는 무시한다. 우리가 `/exit` 로 끈 것이라, 에이전트를 끝난 것으로 바꾸면 안 된다.

### 2.3 작업 중에 온 메시지 (B)

**지금.** 작업 중이면 입력칸에 `BUSY_PROMPT`("지금 읽고, 일을 마친 뒤 처리")를 붙이고 Enter 를 보낸다. 차례가 끝나면 미룬 요청이 있을 때 `REMIND_PROMPT` 를 한 번 보낸다.
- 붙여 넣는 동안 사용자 입력과 겹치거나 "쓰던 글이 있습니다"로 막히는 일이 있다.
- 입력칸 판정이 틀리면 Enter 가 엉뚱한 곳으로 간다.
- 이 경로 때문에 생긴 버그가 여럿이다.

**설계 (Claude 먼저)**
- 작업 중(`hookState === 'working'`)에 온 메시지는 **입력칸에 넣지 않는다.**
- Stop 훅이 오면 훅 스크립트가 main 에 `stop-check` 를 묻는다. main 은 그 에이전트에게 다음이 있으면 `block` 문구를 준다:
  - 아직 안 읽은 메시지(`unreadFor`) 가운데 Stop 훅으로 아직 알리지 않은 것.
  - 또는 미뤄 둔 요청(`unhandledFor`) 가운데 아직 다시 알리지 않은 것.
- 문구는 지금과 같은 영어 한 줄이다. 예: `New ezShell message: read it with read_inbox, then handle it.` / 미룬 요청이면 `REMIND_PROMPT`.
- 알린 메시지 id 를 기록한다(메시지당 한 번). 그래서 `stop_hook_active` 가 true 인 연속 Stop 에서도 새로 온 메시지가 없으면 막지 않는다. 문서의 8회 상한과 함께 무한 반복이 없다.

**Stop block 의 안전 규칙**
- **A1 사용자가 멈춘 차례는 막지 않는다.** 다음 중 하나가 최근 10초 안에 그 셸에 있었으면 block 하지 않는다:
  - 사용자 Esc·Ctrl+C·채팅 `중지`. 정의는 우선순위 3 규칙 7 을 따른다 (한 글자 일치, 앱이 보낸 키 제외, 채팅 중지 포함)
  - 채팅의 `중지` (`interruptAgent`)
  - 이때 메시지는 쉬는 에이전트 경로(빈 입력칸에 `PROMPT`)가 맡는다. 사용자가 멈춘 에이전트를 앱이 다시 움직이면 안 된다.
  - StopFailure(API 오류로 끝난 차례)에도 막지 않는다.
- **A2 "알렸음"은 전달이 확인된 뒤에만 남긴다.** block 뒤 15초 안에 다음 중 하나가 생기면 확인된 것이다:
  - 그 메시지의 `seenAt` (read_inbox 로 읽음)
  - 차례가 이어졌다는 보고: block 한 Stop 과 같은 `promptId` 의 PreToolUse, 또는 같은 `promptId` 의 `stop_hook_active: true` Stop (규칙 3)
  - 둘 다 없으면 알림 기록을 지운다. 그러면 `agentInboxWake` 가 다시 맡아 쉴 때 `PROMPT` 를 붙인다.
  - 대비하는 경우: 훅 5초 시간 초과, CLI 가 block 을 무시, 8회 상한에 걸림, 출력이 다른 훅과 섞여 버려짐.
  - 확인되기 전까지 `agentInboxWake` 는 그 메시지를 보류(`pending`)로 둔다. 확인되면 `dispatched` 로 친다.
- **A1 보강 (T0 ②):** Esc 로 멈춘 차례에는 Stop 자체가 오지 않는다. 그러니 A1 이 실제로 막는 경우는 다음 둘이다:
  - Esc 직후 사용자가 곧바로 새 질문을 보내 그 차례의 Stop 이 10초 안에 오는 경우.
  - 채팅 `중지`가 StopFailure 로 끝나는 경우.
  - 둘 다 사용자의 다음 행동이 먼저이므로 규칙은 그대로 둔다.
- **A3 사용자 대기열 (T0 ⑨ 로 정리됨):** 작업 중에 친 질문은 같은 차례에 흡수되고 Stop 은 그 뒤 한 번 온다. 그래서 "대기열이 남은 채 Stop" 은 관찰되지 않았다. 다만 화면에 대기열 안내(`claudeQueueVisible`)가 남아 있는 Stop 이면 막지 않는다 (안전 쪽).

**바뀌는 것 (사용자에게 보이는 차이)**
- 보낸 쪽의 "읽음"이 지금은 작업 중에 바로 생기는데, 차례가 끝날 때로 늦어진다.

**여전히 입력이 필요한 것**
- 쉬는(idle) 에이전트를 깨우는 일. 쉬는 동안에는 어떤 훅도 오지 않는다.
- 이 경우 지금처럼 빈 입력칸을 확인하고 `PROMPT` 를 붙인다. 다만 "쉬는가"를 훅 상태로 알므로 `quietMs` 짐작이 필요 없다.

**Codex (사용자 결정 2: 이번 단계에 포함)**
- Stop block 은 문서·소스로 확인했다. 대화형 실측은 남아 있다.
- 사용자가 우리 훅을 신뢰한 Codex 에는 Claude 와 같은 규칙을 쓴다.
- 신뢰 전(훅이 오지 않음)에는 지금 방식(`BUSY_PROMPT`)을 그대로 쓴다.

### 2.4 주입 방법

**Claude**
- 지금 상태 줄을 넣는 `agent-settings.json`(`agentMessages.js:601`)에 `hooks` 를 더한다.
- ezShell 이 띄운 Claude(`--settings "$EZSHELL_AGENT_SETTINGS"`, `localShell.js:258,267`)와 셸에 직접 친 claude(`POWERSHELL_CLAUDE_FUNCTION`)가 같은 파일을 쓰므로, 둘 다 별도 작업 없이 받는다.
- 사용자가 `--settings` 를 직접 주면 지금처럼 우리 설정은 빠진다(상태 줄과 같음). 이때는 대체 경로로 간다.
- 명령은 상태 줄과 같은 형태다: `ELECTRON_RUN_AS_NODE=1 "$EZSHELL_CLI_EXE" "$EZSHELL_AGENT_HOOK_SCRIPT" claude`.
- Stop 은 `timeout: 5`, 나머지는 `async: true` 다(상태 보고는 차례를 막지 않음).
- **매처 (T0 ⑦ 결과: 훅 하나 60~110ms, 7개 동시 175ms 이하).** 비용이 작아 PreToolUse·PostToolUse 를 `"*"` 로 받아도 된다. 도구 실행 중인지는 Esc 보정(B3)에 필요하다. 모두 `async` 다. 아래 줄이기 안은 비용 문제가 실제로 보일 때를 위한 것이다.
- (참고: 처음의 줄이기 안) 훅마다 Electron 을 node 로 띄우는 비용이 든다.
  - PreToolUse 는 `matcher: "AskUserQuestion"` 만 받는다.
  - PermissionRequest 는 모두 받는다 (드묾).
  - PostToolUse·PostToolUseFailure 는 대화 상자를 닫는 짝이 필요할 때만 쓴다.
  - 비용이 크면 "대화 상자 닫힘"은 PostToolUse 대신 다음 상태 이벤트(다음 PreToolUse 없음 → UserPromptSubmit·Stop·Notification)나 기존 화면 판독으로 대신한다.

**Codex**
- 실행마다 `-c hooks.<Event>=[…]` 를 붙인다.
- ezShell 이 띄운 codex 와 `POWERSHELL_CODEX_FUNCTION`(셸에 직접 친 codex)의 인자에 넣는다.
- 명령은 셸에 따라 달라 `command_windows` 에 PowerShell 형태를 둔다: `$env:ELECTRON_RUN_AS_NODE='1'; & $env:EZSHELL_CLI_EXE $env:EZSHELL_AGENT_HOOK_SCRIPT codex`.
- 문자열에 설치 경로를 넣지 않고 환경 변수만 쓴다. 그래야 신뢰 해시가 업데이트 뒤에도 같다.
- 신뢰가 없으면 실행되지 않는다(✔실측). 사용자가 Codex 칸에서 한 번 승인한다 (사용자 결정 2). 앱은 신뢰를 대신 기록하거나 `--dangerously-bypass-hook-trust` 를 쓰지 않는다.
- `notify` 는 쓰지 않는다. 사용자 것을 덮어쓰고, 차례 끝 하나뿐이라 훅의 Stop 보다 못하다.

**Codex 훅 승인 흐름 (화면)**

1. **Codex 가 묻는 화면.** 우리 훅을 넣은 Codex 가 처음 뜨면 Codex 가 직접 "Hooks need review" 화면을 띄운다 (§1 실측). 칸은 이 화면 동안 입력칸이 없으므로 지금 규칙대로 채팅 보기가 아니라 터미널을 보인다.

2. **앱의 안내 띠.** 그 칸 위에 안내 띠를 하나 둔다. 자리·모양은 `AgentScreenReturnBar` 와 같다.
   - 띠는 그 화면이 보일 때만 뜬다. 화면에서 "Hooks need review" 와 "K hooks are new or changed" 를 읽는다. 이 문구만은 Codex 버전에 따라 바뀔 수 있어 화면 판독이다.
   - **Trust all 안내 금지 원칙 (규칙 10).** "Trust all" 은 사용자의 다른 미신뢰 훅까지 신뢰한다.
     - 화면의 K 가 우리가 넣는 훅 수 N 과 같을 때만 문구 A 를 쓴다:
       > ezShell 이 Codex 상태를 정확히 알려면 이 칸의 훅을 한 번 승인해야 합니다. 검토할 훅 K개는 모두 ezShell 의 것이라 `2. Trust all and continue` 를 골라도 됩니다. 승인하지 않아도 지금처럼 동작합니다.
     - 그 밖에는 문구 B 를 쓴다. `Trust all`·`t trust all` 은 안내하지 않는다:
       > ezShell 이 Codex 상태를 정확히 알려면 이 칸의 훅을 한 번 승인해야 합니다. `1. Review hooks` 에서 확인해 주세요. 승인하지 않아도 지금처럼 동작합니다.
     - "명령에 `EZSHELL_AGENT_HOOK_SCRIPT` 가 든 항목만 승인" 이라는 안내는, 검토 화면이 항목별 승인을 지원하는지 T9 실측으로 확인한 뒤에 넣는다.
   - **버튼 (규칙 9):** `다음에`(띠만 닫음, 다음 실행에 다시 안내)와 `묻지 않기`(아래 3 의 "넣지 않음"으로 바꿈)를 둔다.

3. **승인 전 대체 동작과 다시 묻는 문제 (규칙 9).**
   - 사용자가 `Continue without trusting` 을 고르거나 화면을 넘기면, 그 실행은 "훅 없음"이다. 상태는 지금의 OSC·제목·rollout 보정, 작업 중 메시지는 `BUSY_PROMPT` 다.
   - 신뢰하지 않으면 Codex 는 실행할 때마다 다시 묻는다. 그래서 앱이 대신 띄우는 실행이 이 화면에 막힌다:
     - 잠재우기에서 깨울 때의 `codex resume`
     - 업데이트 뒤 다시 열기
     - 셸에 직접 친 `codex` 함수
   - 그래서 main 은 "이 PC 의 Codex 가 우리 훅을 보낸 적이 있음"(= 승인됨)을 기억한다. 메모리가 아니라 사용자 데이터에 둔다. 앱이 대신 띄우는 실행에는 그때만 `-c hooks.*` 를 넣는다.
   - 사용자가 직접 띄우는 Codex(ezShell 이 연 Codex 칸의 첫 실행)에는 승인 전에도 넣어 검토 화면이 뜨게 한다. 승인할 기회를 주기 위해서다.
   - 검토 화면이 닫힌 뒤 10초 안에 훅이 하나도 오지 않으면 거절(`Continue without trusting`)로 본다. 띠의 `묻지 않기` 와 같이 다음부터는 넣지 않는다. 다시 켜려면 설정 토글을 껐다 켠다 (토글을 켜면 "넣지 않음"을 지움).

4. **승인 뒤.** 명령 문자열이 고정이라 다음 실행부터는 묻지 않을 것으로 본다(✗미확인, T9 실측). 앱 업데이트로 명령을 바꾸면 해시가 바뀌어 다시 묻는다. 그래서 명령 문자열은 "바꾸면 안 되는 것"으로 CLAUDE.md 에 적는다.

**사용자 전역 설정**
- `~/.claude/settings.json`, `~/.codex/config.toml`, `hooks.json` 은 쓰지 않는다.
- 예외: Codex 의 신뢰 승인은 사용자가 Codex 화면에서 직접 고르는 것이다. 그때 Codex 가 자기 `config.toml` 에 기록한다.

### 2.5 덜 짐작하게 되는 것

**채팅 보기 (`AgentChatCover.tsx`, `agentChatStore`)**
- 머리줄 상태(작업 중 / 입력 대기 / 확인 대기): 제목 스피너 짐작 대신 차례 시작·끝.
- 작업 중에 보낸 말풍선의 `대기 중…`·`앞 작업 진행 중…`, 답변 생성 중 표시의 끝: Stop 으로 확정.
- 전송 확인의 "idle 15초" 기준(`checkSendConfirmations`): idle 이 확실해져 잘못된 `전송 확인 안 됨` 이 준다.
- 확인 질문·Claude 질문 카드가 뜨고 닫히는 시점: PermissionRequest / PreToolUse(AskUserQuestion) → PostToolUse.
  - 카드의 선택지는 여전히 화면에서 읽는다. 질문 내용은 기록에서 읽는다.
  - 이번 질문 카드 버그(카드와 터미널이 번갈아 뜸)처럼 "지금 대화 상자가 있나"를 화면으로 맞히던 부분이 준다.
- 세션 id: SessionStart 의 `session_id` 로 기록 파일을 바로 안다. 지금은 Claude 상태 줄 보고, Codex 감시기의 파일 찾기에 의존한다.

**깨우기 (`agentInboxWake.js`)**
- `isWorking`·`isRunningTask`·`isUnknown`: 훅 상태로 정한다.
- `quietMs`(1.5초 조용하면 쉼으로 침): 훅 있는 에이전트에서는 쓰지 않는다.
- 작업 중 `BUSY_PROMPT` 붙여넣기와 Enter, 작업 끝 `REMIND_PROMPT`: Claude 는 Stop 훅으로 바뀐다. 입력칸을 만지지 않는다.
- 쉬는 에이전트의 `PROMPT` 는 그대로 입력칸을 쓴다. 다만 "쉬는가"는 확실하다.

**그 밖**
- 쉬는 에이전트 잠재우기(`agentIdle.js`): 쉰 시간(`activeAt`)을 Stop 시각으로 정한다.
- 셸이 도는지(`runsCommand`) 대신 "도구 실행 중(PreToolUse ~ PostToolUse 사이)"을 쓸 수 있다 (2단계).
- Codex rollout 보정(`codexUsageWatcher`, `codexActivity`): Codex 훅이 켜진 뒤에는 필요 없다 (결정 1 이후).

**그대로 화면을 읽는 것**
- 입력칸이 비었는지(깨우기, 채팅 보내기).
- 붙여 넣은 글이 그려졌는지.
- 확인 질문의 선택지 문구.
- 슬래시 명령이 연 CLI 화면(`commandScreen.js`).
- 모델·노력 선택 화면(`agentPicker.js`).
- Antigravity 전체 (이번 범위 밖).

## 3. 보안

- **앱으로 가는 것:** 이벤트 낱말·세션 UUID·`tool_use_id`·알림 종류 낱말뿐이다.
- **보내지 않는 것:** 훅 입력의 원문(`prompt`, `last_assistant_message`, `tool_input`, `message`, 경로)은 훅 스크립트 밖으로 보내지 않는다. 화면에도, 로그에도 남기지 않는다.
- **main 의 재검사:** 이벤트는 허용 목록, UUID·id 는 형식, 토큰은 기존 규칙으로 다시 검사한다. 모르는 것은 버린다.
- **훅 스크립트:** 출력은 Stop 의 block JSON 한 줄뿐이다. 그 문구는 main 이 정한 고정 문장(사용자·다른 에이전트의 글을 넣지 않음)이다. 다른 에이전트가 보낸 메시지 본문을 `reason` 에 넣지 않는다. 넣으면 에이전트 간 프롬프트 주입 통로가 된다.
- **훅 입력의 원문 (C1):** stdin 은 끝까지 읽되 허용 목록 키의 짧은 값만 스트림으로 꺼낸다. 원문(`last_assistant_message`, `prompt`)은 모으지도, 메모리에 두지도 않는다 (§2.1).
- **다른 전역 Stop 훅과 합쳐질 때 (C2):** Orca 처럼 사용자가 둔 다른 Stop 훅도 같은 차례에 병렬로 돈다.
  - 그 훅이 block 하면 CLI 가 이유들을 합쳐 Claude 에게 줄 수 있다. 우리 문구는 고정된 영어 한 줄이고 명령·경로·남의 글을 담지 않는다. 그래서 다른 이유와 섞여도 뜻이 바뀌거나 무언가를 실행시키지 않는다.
  - 남의 훅이 내는 출력과 그 결과(차례를 잇거나 멈추게 하는 것)는 우리가 통제할 수 없다. A2 의 전달 확인은 이 경우에도 다시 맡기 위한 장치다.
- **사용자 설정:** 사용자 전역 설정은 쓰지 않는다.
- **Codex 훅 신뢰:** `--dangerously-bypass-hook-trust` 는 쓰지 않는다. 사용자·프로젝트의 신뢰하지 않은 훅까지 풀린다(✔실측·문서).
- **잠금:** 잠금 중에는 `agent-event` 를 거부한다(usage 와 같음).
- **훅 실패:** 실패는 곧 대체 경로다. 훅이 거짓 상태를 보내도 영향은 그 셸 하나의 상태 표시와 알림 시점뿐이다. 명령 실행·입력은 이 경로로 일어나지 않는다.

## 4. 단계별 작업

| # | 작업 | 파일 | 담당 제안 | 확인 |
|---|---|---|---|---|
| T0 | **실측 보완** (완료: Claude 는 2026-11-24 "T0 실측 결과", Codex 승인 뒤 동작은 2026-11-25 "앱으로 한 실측") | 문서만 | 사용자와 함께 | §1 에 반영함 |
| T9 | **Codex main 부분 (1단계, 사용자 결정 2)**: `-c hooks.*` 주입(고정 명령 문자열·`command_windows`), 승인 기억(사용자 데이터: "이 PC 의 Codex 가 우리 훅을 보낸 적 있음" / "넣지 않음")과 앱이 대신 띄우는 실행의 주입 여부(규칙 9), 검토 화면 닫힘 + 10초 무훅 = 거절, Interrupt 로 차례 닫기, 훅 있는 Codex 는 rollout 보정 끄기 | `src/localShell.js`(`POWERSHELL_CODEX_FUNCTION`·띄우는 인자·`resumeCommand`), `src/ipc/agentMessages.js`, `codexUsageWatcher.js` | T1~T5 담당, T3 다음 (규칙 12) | 단위: 주입 인자 고정 문자열, 승인 기억에 따른 주입 여부. 실측: 승인 화면 → 승인 → 다음 실행에 다시 묻지 않음, 승인한 Codex 의 Esc → Interrupt 여부, 검토 화면이 항목별 승인을 지원하는지 |
| T9b | **Codex 승인 안내 띠 (화면)**: 검토 화면을 읽어 띠를 띄움 (K = N 일 때 문구 A, 그 밖엔 문구 B), 버튼 `다음에`·`묻지 않기`(IPC 로 main 의 "넣지 않음") | `AgentScreenReturnBar` 와 같은 자리의 새 부품, IPC 하나 | 화면 담당 (claude-3) | 단위: K·N 비교와 문구 선택 |
| T1 | 훅 보고 스크립트 `src/ipc/agentHookReport.js`: stdin 을 끝까지 비우며 허용 목록 키만 스트림으로 꺼냄(C1) → rpc `agent-event`(`promptId`·`tool_use_id`·`startedAt` 포함). Stop 은 `stop-check` 답으로 block 출력. 실패 시 무출력·0 | 새 파일 + `MAIN_RUNTIME_MODULES` 등록 | main 담당 (T1~T5 한 사람) | 단위: 가짜 훅 입력(이벤트별 JSON, `prompt`·수 MB 의 `last_assistant_message` 가 든 것)으로 보낸 rpc 에 원문이 없는지, 키가 끝에 있어도 꺼내는지, 깨진 JSON·파이프 없음에서 0 종료 |
| T2 | main 수신: `agentMessages.respond` 에 `agent-event`·`stop-check` (토큰·셸 토큰, 잠금, 형식 검사) | `src/ipc/agentMessages.js` | 같은 담당 | 단위 (아래) |
| T3 | 상태 결합: `localShell.js` 의 entry 에 `hookState`·`hookSeenAt` | `src/localShell.js` | 같은 담당 | 단위 (아래) |
| T4 | Claude 주입: `agent-settings.json` 에 hooks (Stop 동기 5초, 나머지 async, 매처는 T0 ⑦ 로) | `src/ipc/agentMessages.js` | 같은 담당 | `agentUsageMessages.test.js` 에 hooks 내용 확인. 실측: 띄운 Claude·직접 친 claude 둘 다 훅이 오는지 |
| T5 | 깨우기 | `src/ipc/agentInboxWake.js` | 같은 담당 | 단위 (아래) |
| T6 | 채팅 기록: Stop 훅이 남기는 줄을 숨김. Claude 는 T0 ① 의 모양(`isMeta` 사용자 줄 `Stop hook feedback:\n…`, `attachment.type:"hook_blocking_error"`, `system/stop_hook_summary`). **Codex (규칙 11):** block 의 `reason` 이 rollout 에 사용자 말풍선 "New ezShell message…" 로 남을 수 있다. 기존 `inboxNotice`(`isInboxPrompt`) 거르기로 덮이는지 T9 실측과 함께 확인하고, 안 덮이면 그 모양을 더함. 세션 바뀜(B4)에 채팅 기록 파일을 다시 연결 | `src/agentChat/claudeTranscript.js`, `codexTranscript.js`, `agentInboxPrompts.js`, `chats.js` | 채팅 담당 | 단위: 기록 줄 고정, `/clear` 뒤 새 파일로 따라감 |
| T7 | 화면: 상태 출처를 개발 표시로만 노출 (머리줄 툴팁 "훅" / "추정"), 동작 변화 없음 | `AgentChatCover.tsx` | 화면 담당 (claude-3) | 수동 |
| T8 | 화면 테스트: 가짜 에이전트(`e2e/support/localAgentFixture.js`)가 훅 스크립트를 직접 불러 상태를 보고하는 모드 추가 | `e2e/support/*`, 명세 | 테스트 담당 | 시나리오 (아래). `npm run e2e -- local-agent-chat`, `local-agent-messages` |
| T10 | 문서: CLAUDE.md 갱신 (아래), 새 `src/ipc/agentHookReport.js` 의 `MAIN_RUNTIME_MODULES` 등록 확인 | `CLAUDE.md`, `electron.vite.config.ts` | T5 담당 | 리뷰 |
| T11 | **설정 토글 (사용자 결정 4)**: 설정 > MCP > 에이전트 메시지 "공식 신호로 상태 받기" 토글과 IPC. 끄면 main 이 `agent-settings.json` 을 hooks 없이 임시 파일 → 이름 바꾸기로 다시 쓰고, Codex 인자에서 `-c hooks.*` 를 빼고, 모든 셸 entry 의 `hookState` 를 즉시 지운다(지금 방식으로 돌아감). 켜면 Codex 의 "넣지 않음"을 지운다. 토글 값은 화면 설정 백업 목록(`UI_SETTING_ENTRIES`)에 넣음 | `Settings/AgentIdleSettings.tsx` 옆 새 부품, `src/ipc/agentMessages.js`, `src/localShell.js`, `lib/uiSettingsBackup.ts` | 화면(토글) + T1~T5 담당(main) | 단위: 끌 때 hookState 가 모두 지워짐, 파일이 원자적으로 바뀜 |

**T0 실측 항목**
- Claude 대화형:
  - ① Stop block 이 차례를 잇는지와 `reason` 의 기록 모양
  - ② Esc 로 멈출 때 Stop 이 오는지
  - ③ PostToolUse `additionalContext` 동작: 하지 않음 (결정 3)
  - ④ `idle_prompt` 가 오는 시점
  - ⑤ 폴더 신뢰 전 `--settings` 훅 보류 여부
  - ⑦ 훅 프로세스 비용: 도구 호출마다 Electron-as-node 를 띄우는 시간·메모리, 에이전트 7개 병렬일 때. 매처로 필요한 도구만 받는 안(§2.4)과 비교
  - ⑧ 긴 도구 실행·하위 에이전트·권한 대기 중의 창 제목 (B3)
  - ⑨ 사용자 대기열이 있을 때 Stop 이 오는지 (A3)
- Codex:
  - ⑥ 신뢰 화면의 모양과 기록 위치 (`-c` 훅의 키 `<session-flags>/config.toml:…`)

**T0 판정 기준**
- ① 이 "아니오"(대화형에서 Stop block 이 차례를 잇지 않음)이면 §2.3(B, 작업 중 메시지)은 모두 무산된다. 지금 방식(`BUSY_PROMPT`)을 유지하고, 상태(A)만 진행한다.
- ② 는 "아니오"였다 (Esc 로 멈춘 차례에는 Stop 이 오지 않음). 그래서 Esc 보정(우선순위 3 의 (a)·(b))이 필수다. A1 은 Esc 직후 새 질문의 Stop·StopFailure 를 위해 남긴다.
- ⑦ 에서 훅 하나의 기동이 0.3초를 넘거나, 병렬 7개에서 눈에 띄는 지연이 있으면 매처를 좁힌다 (PreToolUse 는 `AskUserQuestion` 만, PostToolUse 는 대체).
- ⑨ 가 "예"이면 A3 를 넣는다.

**단위 시험**
- T2: 안 읽은 메시지 2개 → 첫 Stop 은 block, 같은 메시지로 두 번째 Stop 은 통과, 새 메시지가 오면 다시 block.
- T2 (A1·A2): 최근 Esc 뒤 Stop 은 통과. StopFailure 는 통과. block 뒤 15초 안에 `seenAt`·working 이 없으면 알림 기록이 지워져 다음 쉴 때 `PROMPT` 가 맡음.
- T2 (B4): 새 `session_id` 로 역할 저장 키·사용량 세션 키가 바뀜.
- T3: 훅만 / 훅 + 제목 idle 3초 / Esc 뒤 1초 안에 제목 `✳`(idle 로) / PermissionRequest 열림 + 제목 `✳`(blocked 유지) / 훅 없음.
- T3 (⑨): 같은 `promptId` 의 두 번째 UserPromptSubmit 은 새 차례가 아님.
- T3 (규칙 1·2·3·4·6·14): 열린 차례 중 SessionStart(compact)는 상태 그대로, 세션 id 만 갱신. `session_id` 가 같으면 키 갱신 안 함. 닫힌 차례의 늦은 PostToolUse(이른 `startedAt`)는 버림. 우리가 block 한 Stop 은 working, 다음 `stop_hook_active` Stop 에서 idle. Stop 뒤 2초 넘게 제목 스피너면 working. 새 `promptId` 의 UserPromptSubmit·Stop 에 열린 대화 상자가 모두 닫힘. 열린 차례 없는 PostCompact 는 idle.
- T3 (규칙 7): `\x1b` 한 글자만 사용자 Esc. `\x1b[A`·`\x1b[I`·마우스 보고는 아님. 앱이 보낸 Esc 는 아님.
- T3 실측: AskUserQuestion 이 떠 있는 동안의 창 제목 (규칙 5).
- T3 (B1): 순서가 뒤집힌 UserPromptSubmit(이미 Stop 받은 `promptId`)을 버림. 닫힌 `tool_use_id` 의 늦은 열림을 버림.
- T3 (B2): 막 띄운 실행의 10초 규칙. 되살린 셸에서 첫 훅이 늦게 와도 켬.
- T3 (E1): 잠든 셸의 SessionEnd 무시.
- T5: 훅 있는 Claude 는 작업 중 메시지를 입력칸에 넣지 않음, idle 이면 지금처럼 `PROMPT`. Stop 으로 알린 id 는 A2 의 확인 뒤에만 `dispatched`.

**T8 시나리오**
- 작업 중 메시지가 입력칸에 가지 않고 Stop 에서 이어진다.
- (B1) async 보고의 순서가 뒤집혀도(가짜 에이전트가 Stop 을 먼저, UserPromptSubmit 을 나중에 보고) 상태가 idle 로 남는다.
- (A1) 사용자 Esc 직후의 Stop 은 막지 않고, 메시지는 쉴 때 `PROMPT` 로 간다.

**CLAUDE.md 에서 바꿀 곳 (T10)**
- Agent Chat View 절, MCP Server 절의 깨우기 규칙: 작업 중 `BUSY_PROMPT` 를 붙이는 "바꾸면 안 되는 것"이 훅 있는 Claude 에서 바뀐다. 훅 없는 에이전트·Codex 는 그대로다.
- 상태 판단 우선순위와 대체 경로, Stop block 안전 규칙(A1~A3), 훅 입력 원문을 보내지 않는 규칙을 "바꾸면 안 되는 것"으로 적는다.

**담당과 순서 (E2)**
- T1~T5 는 `agentMessages.js`·`localShell.js`·`agentInboxWake.js` 를 함께 고친다. 그래서 한 사람이 맡는다. 나눠야 하면 T2 → T3 → T5 순서로 차례대로 한다.
- 단계 순서: T1·T2 (codex-4, 시작됨) → T3 → T9(main 부분, 같은 담당) → T4 → T5·T6 → T7·T8·T9b·T10·T11. T0 의 Codex 남은 항목은 T9 의 실측과 함께 한다.
- 판정 결과(§1): ① 예라서 B(작업 중 메시지를 Stop 으로)를 진행한다. ② 아니오라서 Esc 보정(B3 의 (a))이 필수다. A1 은 남는다. ⑦ 작아서 매처는 `"*"` 다. ⑨ 대기열은 같은 차례에 흡수된다.

## 5. 위험과 되돌리기

| 위험 | 대응 |
|---|---|
| 훅 스크립트가 느려 Stop 이 차례 끝을 늦춤 | 스크립트 1.5초 상한, 훅 `timeout: 5`. 상태 보고 훅은 `async` |
| Stop block 이 반복됨 | 메시지당 한 번 + `stop_hook_active` + CLI 의 8회 상한 |
| 훅이 오다 멈춤 (CLI 업데이트로 형식 변경) | 형식이 틀린 보고는 버림. 10초 규칙과 보정 규칙으로 기존 신호 사용 |
| 사용자의 `--settings` 와 충돌 | 지금처럼 사용자 것이 있으면 우리 것을 빼고 대체 경로 |
| Git Bash 없는 Windows | 훅이 실패 → 대체 경로 (상태 줄과 같은 조건) |
| 보낸 쪽 "읽음"이 늦어짐 (B) | 사용자 결정 3 으로 받아들임 |
| Esc 로 멈춘 차례에 Stop 이 없어 working 이 남음 (T0 ②) | B3 의 (a)·(b) 보정 (사용자 Esc + 제목 `✳`) |
| Codex 사용자가 승인하지 않음 | 지금 방식 그대로. 안내 띠는 화면이 보일 때만 |
| Codex 의 "Trust all" 이 사용자의 다른 미신뢰 훅까지 신뢰 | 안내 문구에서 먼저 말하고 "Review hooks" 를 첫째로 권함 |
| 명령 문자열이 바뀌어 Codex 가 다시 물음 | 문자열 고정을 CLAUDE.md "바꾸면 안 되는 것"에 적음 |
| Stop block 이 사용자가 멈춘 차례를 다시 움직임 | A1 (최근 Esc·Ctrl+C·`중지` 뒤, StopFailure 에는 막지 않음) |
| block 이 전달되지 않음 (시간 초과·무시·상한·다른 훅과 섞임) | A2 (전달 확인 전에는 "알렸음"이 아님, 15초 뒤 `PROMPT` 경로가 다시 맡음) |
| async 보고 순서가 뒤집혀 working 이 남음 | B1 (`promptId`·`tool_use_id` 짝, `startedAt`) |
| 훅 기동 비용 | T0 ⑦ 측정, 매처로 줄임 |
| 되돌리기 | `agent-settings.json` 에서 hooks 를 빼면(한 줄) 모든 Claude 가 다음 실행부터 지금 방식. main 은 `hookState` 가 없으면 지금 코드 경로와 같다. 기능 스위치 `agentHooks` 를 둔다 (결정 6) |

## 6. 결정

### 사용자 결정 (2026-11-24)

1. **T0 실측에 실제 계정을 쓴다.**
   - Claude 실측은 마쳤다(§1).
   - 생긴 시험 대화 기록은 `~/.claude/projects/C--Users-ysk-AppData-Local-Temp-claude-633eb9d03886753b-f3da8d40-5ff7-4d63-967c-90f524623f87-scratchpad-t0-work-claude/` 의 세 개다. 사용자가 지울 수 있다:
     - `3c3b0ba5-1cec-4a0a-9296-ceb87c7d037f`
     - `7bc51066-dc90-4838-af39-4dff462e3005`
     - `898fed77-b064-4c27-b9d5-ecb284679eff`
   - Codex 는 세션 기록이 생기지 않았다.
2. **Codex 도 이번 단계에 넣는다.**
   - 사용자가 Codex 칸에서 훅 신뢰를 한 번 승인한다.
   - 앱은 신뢰를 대신 기록하지 않고 `--dangerously-bypass-hook-trust` 를 쓰지 않는다.
   - 명령 문자열은 고정해 해시를 유지한다.
   - 화면과 안내는 §2.4 "Codex 훅 승인 흐름", 작업은 T9.
3. **작업 중 메시지는 "일을 마친 뒤 읽기"다** (Stop block). 보낸 쪽의 읽음이 차례 끝으로 늦어지는 것을 받아들인다. PostToolUse `additionalContext` 로 중간에 알리는 안은 하지 않는다.
4. **기능 스위치는 설정 화면의 토글이다** (설정 > MCP > 에이전트 메시지).
   - 끄면 main 이 `agent-settings.json` 에서 hooks 를 빼고 다시 쓴다. 떠 있는 Claude 는 설정 파일을 다시 읽으므로 곧 꺼진다(✔문서).
   - Codex 는 다음 실행부터 `-c hooks.*` 를 넣지 않는다.
   - 토글 값은 화면 설정 백업 목록에 넣는다.

### 남은 결정

5. **상태 출처 표시 (T7):** 머리줄 툴팁에만 "훅" / "추정"을 둘지. 권장: 툴팁에만.
7. **바뀐 훅을 다시 묻는 화면에서의 거절 (2026-11-25 실측에서 나옴):** 지금은 승인했던 사용자도 `3`/Esc 를 누르면 Codex 훅 전체가 꺼진다. 권장: `approved` 상태에서는 그 화면의 Esc 를 "이번만 건너뛰기"로 보고 끄지 않으며(나머지 훅은 신뢰된 채 돈다), 끄는 것은 안내 띠의 `묻지 않기` 로만. 다음에 훅 정의(명령·`async` 등)를 바꾸기 전에 정한다.
6. **Codex 승인 뒤 실측 방법:** 승인 뒤 동작(신뢰 기록 위치, 다음 실행 유지, TUI 의 Stop block)은 인증 파일을 둔 임시 `CODEX_HOME` 이 필요하다. 이 세션에서는 그 복사가 권한 판정에 막혔다. 다음 중 하나가 필요하다:
   - 사용자가 직접 복사한다 (예: 터미널에서 `! ` 로 명령 실행).
   - 그 동작을 허용하는 권한 규칙을 둔다.
   - T9 구현 뒤 실제 사용 중에 확인한다.
