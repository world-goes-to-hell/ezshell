# Antigravity 채팅 보기 1단계

2026-11-23 · Windows 실기 및 구현 계획

## 범위

로컬 셸에서 실행 중인 Google Antigravity CLI `agy`를 기존 채팅 보기로 전환한다. 내부 종류는 `antigravity`, 화면 이름은 **Antigravity**를 쓴다. 같은 PTY를 유지하면서 대화 읽기, 텍스트 보내기, 작업 상태 표시, 확인 질문이나 권한 대기 시 터미널 전환을 제공한다. 확인은 실제 TUI에서 사용자가 한다.

재개·잠재우기, 작업 공간의 대화 기록 패널, 모델·노력 선택 UI, 사용량 줄은 2단계다. 1단계에서는 첨부, 서브에이전트 전달, 메시지 MCP 알림, 자동 캡처 전송, 슬래시 메뉴 자동 조작도 켜지 않는다. 세션 식별과 상태 계약은 이 기능들이 나중에 쓸 수 있게 유지한다. 기존 [채팅 보기 설계](2026-11-19-agent-chat-view.md)를 따른다.

## Windows 1.5.4 실측

`node-pty`의 ConPTY에서 PowerShell을 열고 실제 로그인으로 `agy 1.5.4`를 실행했다. 작업 폴더와 로그, 상태 줄 도우미는 저장소 밖 `%TEMP%/ezshell-agy-live-826374d5`에 있다. `capture.ndjson`은 headless xterm의 화면과 OSC를, `status.ndjson`은 보관할 필드만 고른 상태 줄 JSON을 담는다. 아래 표는 주로 105×30, 기본 인라인 모드의 결과다. workspace 신뢰 화면은 alternate buffer로 바뀌었다. 테스트 대화는 CLI에 남겨 두었다.

| 상황 | 확인한 출력과 동작 |
| --- | --- |
| 빈 입력칸 | 위아래 `─` 구분선 사이에 `> `만 보였다. 캐럿은 첫 글자 위치이고 어두운 문장 안내는 없었다. 기본 줄의 `? for shortcuts`와 모델·노력 표시가 그 아래에 있다. 상태 줄 도우미는 기본 줄 아래에 덧붙일 수 있었다. |
| 보통 입력 | DEC 2004가 켜진 상태에서 `CSI 200~` / `CSI 201~`로 감싼 붙여넣기가 초안을 그렸다. 글이 있으면 `? for shortcuts`가 숨었다. 한글과 여러 줄은 화면에 그대로 보였다. 붙여넣기 자체는 전송하지 않았다. |
| 이모지 | `A 😂 B ✨ C` 및 결합·변형 선택자·국기 사례가 화면의 초안에서는 `A  B  C` 같은 형태로 보였다. 제출하지 않은 화면 검사라 어느 단계에서 글자가 바뀌었는지, 전송 내용에도 영향이 있는지는 이 결과로 판단할 수 없다. |
| 긴 입력 | ASCII 1,000자까지 펼쳐졌고 1,001자부터 `[Pasted text #1 1001 chars]` 형태가 보였다. 짧은 명시적 줄의 경우 15줄까지 펼쳐지고 16줄부터 `[Pasted text #1 +16 lines]` 형태가 보였다. 문자·줄 경계는 별도로 측정했다. 칩 번호는 같은 편집기의 붙여넣기에 따라 바뀔 수 있다. |
| 작은 칸 | 한 줄 550자 미만의 초안을 40×12, 40×8에서 각각 `> ↑ 12 more lines`, `> ↑ 14 more lines`와 끝부분으로 그렸다. 8행에서는 위 구분선이 화면 밖으로 밀렸다. 이 행과 아래 구분선·푸터는 **초안** 판독의 근거다. |
| 작업 중 | 초안이 비어 있어도 구분선 사이 `> `는 남는다. 위쪽 스피너·`Working...`/`Generating...`, 아래쪽 `esc to cancel`, OSC `state=working:app=antigravity`가 구분 신호다. 응답 완료 시 OSC `state=done`, `? for shortcuts`가 돌아왔다. |
| 신뢰·질문 | 임시 폴더 신뢰 화면은 `Do you trust the contents of this project?`, `Yes, I trust this folder`, `No, exit`와 OSC `blocked:kind=permission`이었다. 대화 중 실제 선택 질문은 `Question 1/1`, `> 1.…`, `Write-in...`, `↑/↓ Navigate · enter Select · esc Skip`, OSC `blocked:kind=question`을 보였다. DEC 2004는 두 화면에서도 켜져 있었다. |
| 도구 권한 | 세션 설정에 `permissions.ask`를 주고 로컬 읽기 전용 명령 실행을 요청했으나 모델이 본문으로 승인을 물었다. 도구 호출 카드와 `tool_confirmation_pending: true`는 실측하지 못했다. `/permissions` 관리 화면 및 startup trust 화면은 캡처했다. 본문의 승인 요청은 도구 권한 카드와 구분한다. |
| 명령과 선택창 | `/` 뒤 완성 목록과 선택표시 `>`를 확인했다. `/model`은 `Switch Model`과 ↑/↓ 모델, ←/→ 노력, `/effort`는 `Set Effort`와 ←/→를 표시했다. 둘 다 Esc로 닫았고 모델·노력 값을 저장하지 않았다. 본 UI는 기존 채팅 입력칸의 `>`와 별개다. |
| 셸 복귀 | `/exit` 뒤 OSC `idle`이 한 번 더 나왔지만 `agy`가 끝나고 PowerShell의 실제 입력 행으로 돌아왔으며 DEC 2004는 꺼졌다. CLI는 복귀 전에 `agy --conversation=<id>` 안내를 남겼다. 인라인에서는 활성 `agy`의 위쪽에도 **이전** PowerShell 명령줄이 남는다. |

다음 지연은 harness가 paste와 별도 `\r`를 PTY에 쓴 시점의 차이다. 같은 화면에서 짧은 ASCII 본문을 한 번씩 시험했다. 제어된 송신 시각과 CLI가 키를 처리한 시각은 구분한다.

| 목표 지연 | 기록된 지연 | Enter부터 첫 OSC `working` | 확인 결과 |
| --- | ---: | ---: | --- |
| 0 ms | 1 ms | 71 ms | 짧은 응답 완료 |
| 100 ms | 105 ms | 30 ms | 짧은 응답 완료 |
| 300 ms | 306 ms | 30 ms | 접수 및 선택 질문 표시 |
| 500 ms | 513 ms | 30 ms | 접수 및 텍스트 응답 완료 |

네 번 모두 사용자 입력이 기록에 남았고 이번 조건에서는 Enter가 줄바꿈으로 남은 사례가 없었다. 질문을 Esc로 건너뛴 뒤 나온 후속 응답을 포함해 새 대화 기록에 모델 응답 단계가 다섯 개 있다. 장문·여러 줄·이모지는 초안에서만 시험했다. 1 ms 사례 하나로 운영 지연을 줄이지 않는다. 기존 안정 판독과 단일 Enter 규칙을 유지한다.

### 상태 줄과 기록

- 앱이 만든 `--settings`에 `statusLine`의 `type: command`, `command`, `stack_with_default: true`를 지정하고, Windows `.cmd` 도우미가 stdin JSON을 읽었다. `version`은 `1.5.4`, `product`는 `antigravity`였다. `cwd`, `workspace`, `session_id`, `conversation_id`, `transcript_path`, `model`, `context_window`, `quota`, `agent_state`, `terminal_width`를 관찰했다. 첫 턴 전 ID 두 값은 빈 문자열이고, 이후 두 값이 동일한 UUID였다. `agent_state`는 `authenticating`, `initializing`, `idle`, `working`, `tool_use`가 나왔다. `model`의 `effort`와 `quota`는 시작 초기에 빠질 수 있고, `context_window.current_usage`는 첫 응답 전 `null`이었다. 쿼터 버킷의 값은 `remaining_fraction`, `reset_time`, `reset_in_seconds` 모양이다. 일부 프레임은 계정 정보도 포함하므로 reporter는 허용된 필드만 전송한다. [공식 상태 줄 계약](https://antigravity.google/docs/cli/statusline/)
- **보고된 경로에 주의.** 실측 `transcript_path`는 `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl`이었으며 파일이 없었다. 실제 `agy` 파일 두 개는 `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/` 아래에 있었다. ID로 검증된 CLI 경로를 조립한다. 경로 보고가 먼저 들어와도 ID가 비어 있으면 파일을 선택하지 않는다.
- **승인 표지는 별도.** 공식 `tool_confirmation_pending`은 선택 필드다. 이번 상태 줄에서는 실제 선택 질문을 포함해 나오지 않았으며, OSC의 `blocked:kind=question`은 나왔다. 상태 줄에 필드가 없거나 예전 `idle` 보고가 남아 있어도 최신 OSC 차단을 해제할 근거로 쓰지 않는다. [OSC 7501 릴리스 노트](https://antigravity.google/docs/changelog)
- 새 대화의 `transcript_full.jsonl`과 `transcript.jsonl`은 각각 10개 행이었다. 네 `USER_EXPLICIT/USER_INPUT`, 다섯 `MODEL/PLANNER_RESPONSE`, 한 `MODEL/GENERIC`을 확인했다. 행은 `step_index`, `created_at`, `source`, `type`, `status`, 텍스트 `content`를 공통으로 쓰고 모델 행에 `thinking`, `tool_calls`, 토큰 수가 올 수 있다. 두 파일에는 같은 단계의 행이 있으므로 한 파일만 선택한다. 이전 조사에서 실제 저장소의 `history.jsonl`과 대화별 SQLite도 확인했다. v1에 필요한 텍스트는 JSONL에 이미 있다. [Orca 기록 가져오기](https://github.com/stablyai/orca/blob/2d6874662274b97e68fc3bbc681026bbdda559e9/src/main/antigravity/antigravity-transcript-import.ts)

### 사용자 설정 확인

실행 전 설정, MCP, 훅과 관련 파일 여섯 개를 임시 폴더에 복사하여 SHA-256을 맞췄다. 종료 뒤 `antigravity-cli/settings.json`의 `trustedWorkspaces` 배열에 실기용 작업 폴더 한 개만 추가된 것을 확인했다. 기존 다섯 항목, 다른 최상위 키와 값은 그대로였다. 이미 있던 `statusLine` 값도 같고 세션에서만 준 `permissions`와 `queuedMessages`는 파일에 생기지 않았다. 나머지 설정·MCP·훅은 해시가 같았다. 사용자 결정으로 신뢰 항목과 테스트 대화를 보존한다. 다음 실기는 같은 임시 작업 폴더를 쓴다.

## 1단계 설계

### 로컬 셸 결합과 상태

- Windows PowerShell의 일반 `agy` 실행을 먼저 지원한다. 관리 실행은 `antigravity`를 실제 `agy.exe`/`agy` 명령으로 명시적으로 매핑한다. 직접 실행은 기존 로컬 셸 래퍼 구조를 활용한다. 앱 소유 도우미를 세션 한정 `--settings`로 주고 사용자 인자를 그대로 전달한다. 사용자가 `--settings`를 직접 준 경우 그대로 존중한다. 별도의 신뢰할 수 있는 세션 결합이 들어오기 전에는 그 실행에 대한 전송을 허용하지 않는다. 첫 단계에서는 파일 경로나 임의의 이미 실행된 PTY를 추정해 붙이지 않는다.
- 상태 보고는 기존 셸 토큰과 실제 `agy` PID/PTY 조상 검증을 같이 거친다. 첫 보고의 필드를 사용하지 않는 일반 Node PID, 이름만 같은 프로세스, 동일 폴더나 OSC 문자열 하나로 붙이지 않는다. `product/version`, 검증한 대화 UUID, 상태, 승인 여부처럼 최소 필드만 main으로 보낸다. 도우미는 토큰·계정·대화 본문을 stdout이나 상태 로그에 기록하지 않는다. 사용자가 이미 쓰는 상태 줄은 보존하고, 필요한 합성이 불가능하면 해당 실행에 별도 opt-in을 적용한다.
- 로그인·신뢰·선택창·오류·실행 중 조합을 하나의 `idle`로 접지 않는다. 현재 `localShell.js`의 OSC 7501 파서와 probe 응답을 재사용한다. `app=antigravity`로 확인된 최신 `blocked`와 TUI 화면을 상태 줄의 오래된 `idle`보다 우선한다. `done`/`idle`은 재판독 계기다. CLI 종료와 PID 교체 시 이전 세션 보고·관찰기·전송을 폐기한다. 처음에는 PID가 확인되고 입력칸까지 확인될 때만 새 대화의 첫 텍스트를 보낼 수 있다. 첫 턴 뒤 도착한 UUID를 같은 PTY 실행에 묶어 기록을 연다.

### 기록, 보기, 전송

- main은 로컬 사용자의 `antigravity-cli/brain`과 검증된 UUID를 사용해 `transcript_full.jsonl`을 우선 선택하고 `transcript.jsonl`을 차선으로 삼는다. 길이·완성 줄·I/O 상한을 기존 tail/older와 같이 적용한다. 절대 경로/UNC/정션·심볼릭 링크로 root 밖을 읽지 않도록 검사한다. 파일 없음은 대기 상태로 두고, 같은 파일 경로의 교체·잘림과 대화 변경을 감지해 parser와 cursor를 함께 초기화한다. renderer는 세션 id나 파일 경로를 지정하지 않는다.
- codex-3의 `createAntigravityParser`를 provider 선택 지점에 명시적으로 연결한다. `chats.js`의 실시간/이전 페이지/복사 경로, 활동 판정과 질문·서브에이전트 분기를 점검한다. 현재 parser는 질문과 답변, 생각·도구 호출 요약, 토큰을 기존 항목 형태로 내보낸다. 일반 `GENERIC` 행을 도구 결과에 추정으로 연결하지 않는다. 사용량 줄과 이력 검색은 별도 후속 기능이다. Parser 자체는 codex-3이 기존 기록 89개로 검증했다고 보고했다.
- `agentInboxWake`에 명시적인 Antigravity 화면 판독을 추가한다. 일반 `>` 한 글자만으로 빈 입력칸·권한 여부를 판정하지 않는다. 두 구분선·캐럿 위치·푸터와 OSC/라이브 PID를 조합한다. 접힌 `> ↑ N more lines`와 칩은 관찰된 초안의 증거로만 쓴다. 인라인에서 옛 PowerShell 프롬프트는 상단에 남을 수 있고, 현재 캐럿이 실제 셸 프롬프트에 놓이거나 PID가 끝나면 전송을 차단한다. 알려지지 않은 화면은 터미널로 전환할 수 있게 한다.
- v1은 **확인된 idle과 빈 입력칸**에서만 텍스트를 보낸다. 작업 중 전송이나 CLI 자체 대기열은 실기 확보 뒤 확장할 수 있도록 개별 상태로 남긴다. 브래킷 붙여넣기, 기존 500 ms 최소 대기와 안정 재판독, Enter 직전의 PID·화면·사용자 키·차단·같은 셸 확인을 그대로 적용한다. 원문과 다르게 보여도 실제 활성 입력칸 내용이 바뀌고 비지 않은 것이 확인될 때만 기존 안정 경로를 쓴다. 이모지만 보내 화면에 입력이 안 잡히는 사례에서는 보류한다. Enter는 한 번이다.
- 채팅이 열려 있을 때 확인 질문·도구 권한·신뢰·로그인은 중단 상태로 표시하고 실제 터미널로 넘긴다. 선택 창을 닫을 때까지 채팅에서 텍스트, 승인 키, 자동 알림을 보내지 않는다. 확인이 끝난 시점에는 해당 실행의 입력칸을 다시 확인한다. `> 1.…` 메뉴와 실제 입력칸이 동시에 보이는 화면을 전송 차단 회귀 시험에 넣는다. 실제 실행 도구 권한 카드는 캡처를 확보한 뒤 별도로 판독한다.

## 파일별 작업 분할 제안

각 행 담당은 구현 배정 전에 확정한다. 여러 행이 같은 공용 파일을 수정해야 하면 표에 적은 한 담당이 합친다.

| 묶음 | 담당 제안 | 소유 파일과 인계 계약 |
| --- | --- | --- |
| 로컬 실행·상태 결합 | codex-4 | `main.js`, `src/localShell.js`, `src/ipc/agentMessages.js`, 새 `src/ipc/antigravityStatusReport.js` 및 해당 단위 시험. `shellId`, provider, 검증된 `conversationId`, 상태, 승인 차단과 같은 최소 snapshot을 제공한다. role 작업이 진행 중인 `main.js`/`agentMessages.js`는 그 작업과 조율한 뒤 한 사람만 편집한다. |
| 기록 파일과 reader | codex-3 | `src/agentChat/antigravityTranscript.js`와 테스트, `src/agentChat/chats.js`와 테스트. 필요하면 `src/agentChat/antigravitySessions.js`에 검증된 ID 기반 resolver를 둔다. live, older, copy가 같은 provider를 쓰게 하고 CLI 기록 패널은 건드리지 않는다. |
| 입력칸과 송신 가드 | codex-5 또는 별도 지정 | `src/ipc/agentInboxWake.js`, provider 전용 화면 fixture/테스트, `src/ipc/agentInboxWake.test.js`. Claude/Codex 승인 포커스·응답 수정이 끝난 뒤 Antigravity 판독을 추가한다. `src/localShell.js` 연결 변경은 실행·상태 담당이 합친다. |
| 채팅 IPC와 화면 | PL이 지정 | `src/agentChat/ipc.js`, `src/preload.js`, `src/renderer/types/index.ts`, `src/renderer/components/AgentChat/`, `LocalTerminalTab.tsx`, `pendingChatViews.ts`와 provider 표지. `AgentIdentity`와 공용 타입을 맡은 작업이 있으면 그 담당이 병합한다. 채팅 전환과 터미널 복귀를 연결하고 후속 기능에는 capability 가드를 둔다. |
| 통합 및 화면 시험 | PL과 기술 리드 | 새 `e2e/specs/local-agent-chat-antigravity.js`, `e2e/support/localAgentApp.js`/`agentChatApp.js`에 가짜 `agy`와 statusLine/OSC/기록 fixture를 연결한다. 기존 `local-agent-chat` 명세의 2종 변형을 별도로 유지한다. 배포 빌드에서도 상태 도우미가 실행되는지 확인한다. |

### 출시 전 확인

- 같은 작업 폴더의 두 `agy` PTY가 서로의 기록과 상태를 받지 않는지, 오래된 토큰·PID와 잘못된 UUID/경로가 붙지 않는지 확인한다. 빈 UUID에서 첫 메시지 이후의 전환과 CLI 종료 뒤 늦게 도착한 상태 보고를 포함한다.
- 첫 표시·추가 기록·이전 기록·파일 교체/잘림·복사가 동일한 parser와 파일 선택을 쓰는지 확인한다. 파일이 제때 없거나 깨진 줄이 와도 이전 대화가 새 채팅에 섞이지 않아야 한다.
- Windows 실기에서 빈/수동 초안, 두 긴 붙여넣기 칩, 한글·이모지·좁은 칸, 인라인 및 alternate 모드, 신뢰와 실제 질문, 런타임 도구 권한, 선택창과 PowerShell 복귀를 확인한다. 런타임 권한 카드와 장문 Enter는 이번 시험에서 남은 검증이다. 권한·질문·셸 상태의 PTY에 Enter가 가는지 별도 회귀 시험을 둔다.
- `antigravity`가 모델 피커, 사용량 줄, history resume, sleep, quick capture, 첨부나 메시지 MCP의 두 종류 전용 경로에 들어가지 않는지 확인한다. Claude/Codex 기존 전송과 승인 응답도 함께 돌린다.

참고 자료는 [Antigravity CLI 명령](https://antigravity.google/docs/cli/reference/), [CLI 설정](https://antigravity.google/docs/cli-settings), [권한 정책](https://antigravity.google/docs/cli-permissions), [Orca의 Antigravity 화면 규칙](https://github.com/stablyai/orca/blob/2d6874662274b97e68fc3bbc681026bbdda559e9/src/main/runtime/agent-state-rules/antigravity.json)이다.
