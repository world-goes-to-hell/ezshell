# 에이전트 채팅 보기 (칸마다 터미널 ↔ 채팅)

날짜: 2026-11-19
상태: 1단계 구현 완료 (2026-11-19, 커밋 전). 단위 테스트·화면 테스트 `local-agent-chat` 통과.

**사용자 결정 (2026-11-19)**: 1단계는 로컬(Claude·Codex), SSH 는 3단계. 단축키 `Ctrl+Shift+F11`. 에이전트가 작업 중일 때 보낸 글은 대기열에 두지 않고 바로 붙여 넣는다.

## 요청

Orca(MIT, https://github.com/stablyai/orca)의 native chat 처럼, 셸에서 돌고 있는 Claude Code·Codex 를 터미널 화면 대신 채팅 화면으로 보고 쓴다.
**Orca 와 다른 점 (사용자 요구)**: Orca 는 탭 하나에 칸이 여러 개여도 한 칸만 채팅으로 볼 수 있다. ezShell 은 모든 셸(칸)이 각자 채팅 보기로 바뀔 수 있어야 한다.

## Orca 는 어떻게 하나 (2026-11-19 main 의 코드로 확인)

Orca 에는 채팅이 두 종류 있다. 사용자 문서는 `docs/site/content/docs/agents/native-chat.mdx`.

1. **터미널 위 채팅 (terminal-backed)**: 터미널 PTY 에서 돌고 있는 에이전트는 그대로 두고, 그 칸 위에 채팅 화면을 덮는다 (`TerminalPaneNativeChatPortal.tsx`, `NativeChatPaneCover.tsx` 의 `absolute inset-0`). 전환해도 프로세스는 그대로다.
   - 대화는 에이전트가 디스크에 남기는 기록 파일을 따라 읽는다 (Claude `~/.claude/projects/<폴더>/<id>.jsonl`, Codex `sessions/**/rollout-*.jsonl`, `session-file-resolver.ts`). 어느 파일인지는 Orca 의 에이전트 훅이 알려 준다. 기록이 없으면 터미널 글자를 긁는다 (우선순위 기록 3 > 훅 2 > 긁기 1).
   - 입력은 PTY 에 줄 지우기 → 괄호 붙여넣기 → 따로 Enter (`native-chat-runtime-send.ts`). 중지는 Esc, 승인은 키 `1`.
   - 칸 선택은 탭마다 `viewMode` 하나와 `layout.chatLeafId` 하나다 (`workspace-layout-tab-commands.ts`). **그래서 한 탭에 채팅 칸이 하나뿐이다.**
2. **앱이 직접 실행하는 채팅 (structured)**: 터미널 없이 Claude Agent SDK(`query()`)·`codex app-server`(JSON-RPC)로 따로 띄운다. 승인은 SDK `canUseTool`, Codex 의 `requestApproval` 요청. 대화는 SQLite 일지에 쌓는다.

규모: 두 종류를 합쳐 약 40만 줄 (`main/native-chat` 13만, 화면 `components/native-chat` 9만 등). 통째로 가져오지 않고 1번의 구조를 참고해 ezShell 에 맞게 새로 만든다. 코드를 가져오는 곳이 생기면 MIT 저작권 표기를 남긴다.

## 결정 (제안, 확인 필요)

- **방식은 1번(터미널 위 채팅)**. 셸·에이전트 프로세스는 그대로이고 보기만 바뀐다. 언제든 터미널로 돌아가 TUI 를 직접 쓸 수 있다.
- **채팅 보기는 셸마다 따로**. 탭이나 칸 배치가 아니라 셸 id(`local:<n>` 셸의 main id)에 상태를 둔다. 그래서
  - 한 탭의 6칸이 모두 채팅일 수 있고, 일부만 채팅일 수도 있다.
  - 칸을 옮기거나(자리 바꾸기·탭으로 빼기·칸으로 병합·창 새로고침 뒤 되살리기) 셸이 다른 칸·탭으로 가도 채팅 보기가 따라간다. 따로 옮겨 줄 상태가 없다.
- **1단계는 로컬 터미널의 Claude Code·Codex**. 이 PC 의 셸은 main 이 이미 셸마다 에이전트 종류·세션 id·상태를 알고 있다 (아래 "이미 있는 것"). SSH 서버의 에이전트는 3단계.
- 앱이 에이전트를 직접 실행하는 방식(Orca 2번)은 만들지 않는다. 승인 버튼이 꼭 필요해지면 그때 다시 판단한다.

## 이미 있는 것 (그대로 쓴다)

- 셸 ↔ 에이전트 ↔ 세션 id: 로컬 셸마다 셸 토큰(`EZSHELL_SHELL_TOKEN`)이 있고, 사용량 보고가 세션 id 를 준다. Claude 는 상태 줄 입력의 `session_id`(`src/ipc/agentUsage.js` 의 `sessionIdOf`), Codex 는 `codexUsageWatcher.js` 가 그 에이전트의 기록 파일을 찾아 쓴 id. 에이전트 종류는 메시지 목록(`agentKindsByShell`). **Orca 의 훅이 하던 일을 이미 하고 있어서 셸마다 정확한 기록 파일을 알 수 있다** (같은 폴더에서 Claude 둘을 띄워도 섞이지 않는다).
- 에이전트 상태: 제목·OSC 7501 로 작업 중 / 쉼 / 시작 중 / 확인 대기 (`localShell.js` 의 `agentStatus`, 제목 판정 `WORKING_TITLE`).
- 입력칸 읽기와 안전한 붙여넣기: `agentInboxWake.js` 가 main 의 headless xterm 으로 에이전트 입력칸을 읽고(`composer`, Claude 는 `───` 줄 사이), 비어 있을 때만 붙여 넣고, 붙인 글이 그대로 그려진 것을 본 뒤에만 Enter 를 보낸다.
- 기록 파일 위치와 안전한 읽기: `src/agentHistory/` 의 `agentRoots`(`CLAUDE_CONFIG_DIR`·`CODEX_HOME`), `boundedRead.js` 의 `readLinesFromEnd`(끝에서부터 상한 있게, `.zst` 풀기), 사용자 입력 판정 `claude.js` 의 `promptText`.
- Markdown: `lib/markdownRender.ts` (markdown-it, `html: false`, 안전한 링크만, 이미지는 대체 글).
- 칸 아래 사용량 줄(`AgentPaneUsage`)과 칸 포커스 테두리(`.is-split .local-terminal-pane:focus-within::before`).

## 화면

- 칸 위에 덮는 층(`.agent-chat-cover`, 칸 안에서 `absolute inset: 0`). xterm 은 그 아래에서 마운트된 채 크기·출력이 그대로 간다 (전환할 때 다시 그리거나 크기를 바꾸지 않는다). 사용량 줄은 덮지 않는다.
- 덮는 층의 구성:
  - 머리줄: 에이전트 표지(Claude/Codex), 대화 제목(`agent-name` → `ai-title` → 첫 질문), 상태(작업 중 애니메이션 / 쉼 / 확인 대기), `터미널 보기` 버튼.
  - 대화: 사용자 말풍선, 에이전트 답(Markdown), 생각(접힘), 도구 호출 카드(이름 + 한 줄 요약, 누르면 입력·결과 펼침), 파일 수정은 diff 카드, 할 일 목록(TodoWrite·Codex plan). 하위 에이전트(`isSidechain`)는 한 카드로 접는다. 대화 요약(`isCompactSummary`)·새 대화(`/clear` 로 세션 id 가 바뀜)는 구분선.
  - 입력창: 여러 줄, Enter 보내기 / Shift+Enter 줄바꿈, `중지`(Esc). 에이전트가 작업 중이어도 바로 붙여 넣고 Enter 를 보낸다 (사용자 결정: Claude 는 작업 중 입력을 받아 다음 차례에 읽는다). 입력칸이 비어 있지 않으면(사용자가 터미널에서 치던 글) 보내지 않고 알린다.
  - 확인 대기: 상태가 확인 대기이면 입력창 자리에 "터미널에서 확인이 필요합니다" 와 `터미널 보기` 버튼 (1단계는 승인 키를 보내지 않는다).
- 전환: 칸 우클릭 `분할` 옆에 `채팅으로 보기` / `터미널로 보기`, 칸 머리 손잡이 옆 작은 버튼, 단축키(기본 `Ctrl+Shift+F11`: Orca 의 Windows 키와 같음, 설정 > 단축키에서 바꿈)는 키보드가 있는 칸. 명령 팔레트에 `이 탭의 에이전트 칸 모두 채팅으로` / `모두 터미널로`.
- 에이전트가 없는 셸은 채팅으로 바꿀 수 없다 (메뉴 비활성, 이유 표시). 채팅 보기 중에 에이전트가 끝나면 "Claude 가 종료되었습니다" 와 `터미널 보기` (입력창 잠금).
- 여러 칸이 채팅일 때 각 칸은 자기 대화만 그린다. 포커스 테두리는 지금 규칙 그대로 입력창이 있는 칸에 그려진다.
- 사이드바 칸 배치 그림(`PaneLayoutBadge`, `PaneMap`)에 채팅 보기 칸 표시(작은 말풍선).

## main 설계 (`src/agentChat/`, 새 폴더)

- `transcripts.js`: 셸 id → (에이전트 종류, 세션 id) → 기록 파일. Claude 는 `projects/*/<id>.jsonl`(폴더 이름은 셸 폴더에서 계산하고, 없으면 `projects` 의 하위 폴더에서 그 이름의 파일을 찾는다), Codex 는 감시기가 이미 찾은 파일. 세션 id 는 UUID 형식만.
- `claudeTranscript.js` / `codexTranscript.js`: 줄 → 화면용 항목. 허용 목록 방식이다 (모르는 줄 종류는 버린다: CLI 버전마다 새 종류가 생긴다).
  - Claude (이 PC 의 기록으로 확인): `assistant` 줄은 줄마다 내용 블록 하나이고 같은 `message.id` 끼리 한 답이다 (313줄 → 답 150개, 블록 둘 이상인 줄 0). 블록은 `text`·`thinking`·`tool_use`. `user` 줄은 문자열(사용자 입력, `isMeta` 와 `<command-…>` 주입은 `promptText` 규칙으로 뺌) 또는 `tool_result`(`tool_use_id` 로 호출과 짝, `toolUseResult` 에 수정 내용). `system`·`ai-title`·`agent-name` 은 머리줄·구분선용. `attachment`·`api-request*`·`file-history-*`·`queue-operation`·`mode` 등은 버린다.
  - Codex: `event_msg:item_completed` 의 사용자 메시지(에이전트 기록과 같은 규칙), `response_item` 의 `message`(assistant)·`function_call`/`_output`·`custom_tool_call`/`_output`, 할 일은 `update_plan`.
- `watch.js`: 열린 채팅 보기마다 그 파일을 따라 읽는다. 파일 끝 위치를 들고 커지면 늘어난 부분만 읽고(최대 1MB, 넘으면 "N 건너뜀"), 줄바꿈 전 조각은 붙잡아 둔다. 줄었거나 다른 파일이 되면 처음부터. 알림은 `fs.watch` + 1초 `stat`(감시가 빠지는 경우). 세션 id 가 바뀌면(`/clear`, 새 대화) 새 파일로 옮겨 가고 구분선 항목을 보낸다.
- 처음 열 때는 끝에서 2MB 만 읽어 최근 대화를 그리고, 위로 스크롤하면 그 앞을 2MB 씩 더 읽는다 (`readLinesFromEnd` 에 시작 위치를 받는 형태 추가). 이 프로젝트의 기록 파일 하나가 수십 MB 다.
- `ipc.js`:
  - `agent-chat-open { shellId }` → 처음 항목들 + 이후 `agent-chat-items` 로 추가분을 보냄. `agent-chat-older { shellId, before }`, `agent-chat-close { shellId }`.
  - `agent-chat-send { shellId, text }`: 그 셸에 에이전트가 돌고 입력칸이 보이고 비어 있을 때 붙여 넣고(작업 중이어도), 그려진 것을 확인한 뒤 Enter (`agentInboxWake` 의 확인 로직을 함수로 빼서 함께 쓴다). 확인 대기(승인 질문) 중에는 보내지 않는다: 붙인 글이 선택지 입력이 된다. 아니면 이유와 함께 거절 (`approval`, `composer-not-empty`, `no-composer`, `not-agent`). 메시지 알림의 붙여 넣기와 겹치지 않게 셸마다 한 번에 하나만 쓴다.
  - `agent-chat-interrupt { shellId }`: 그 셸에 에이전트가 돌고 있을 때만 Esc.

## 바꾸면 안 되는 것 (보안·안전)

- **글을 셸 명령으로 실행시키지 않는다.** 보내기는 main 이 그 셸에서 에이전트가 돌고 있고(메시지 목록·상태) 화면에 에이전트 입력칸이 보일 때만 한다. 에이전트가 끝나 셸 프롬프트로 돌아왔는데 채팅 입력이 셸로 가면 명령이 실행된다. 입력칸을 못 찾으면 보내지 않는다. 붙인 글이 입력칸에 그대로 그려진 것을 본 뒤에만 Enter.
- 화면은 셸 id 와 글만 보낸다. 파일 경로·세션 id 는 main 이 자기 기록으로 정한다 (에이전트 기록과 같은 규칙).
- 대화에는 비밀이 섞인다 (도구 결과의 `cat .env` 등). 파일은 main 만 읽고 화면에는 열린 채팅 보기의 항목만 보낸다. 디스크에 따로 쓰지 않는다. 앱을 잠그면 감시를 모두 멈추고 화면의 대화를 지운다 (DB 탭과 같은 이유).
- MCP·원격 접속·에이전트 메시지로 내보내지 않는다. `agent-chat-*` 는 본창에서, 잠금 해제 상태에서만 받는다.
- Markdown 은 `markdownRender.ts` 로만 (원본 HTML 없음, 이미지 없음). 도구 결과는 글자로만 보여 주고 64KB 에서 자른다 (펼친 카드에서 "전체 보기"는 터미널 보기로 안내).

## 성능·부담

- 감시는 열린 채팅 보기만 (숨은 탭의 채팅 보기도 계속: 돌아왔을 때 따라잡을 양이 크지 않게). 전체 상한 24개.
- 화면에는 채팅 보기마다 최근 항목 2,000개까지 둔다. 넘으면 앞에서부터 버리고 위로 스크롤하면 다시 읽는다. 목록은 보이는 줄만 그린다 (SFTP 목록의 `useListWindow` 는 줄 높이가 같아야 해서 못 쓴다: 높이가 다른 항목용 창 계산이 따로 필요).
- 작업 중 출력은 50ms 마다 묶어서 보낸다 (MCP 활동과 같은 이유).

## 단계

1. **로컬 보기 + 보내기**: 위의 화면·main 설계. Claude·Codex. 칸마다 전환, 단축키, 명령 팔레트 일괄 전환.
2. **확인 응답·복원**: 확인 대기일 때 터미널 화면의 선택지를 읽어 버튼으로 보여 주고, 누르면 그 순간 화면에 같은 선택지가 있는지 다시 본 뒤 키를 보낸다. 업데이트 뒤 탭 다시 열기(`restoreTabs`)에 칸별 보기 상태 포함.
3. **SSH 서버의 에이전트**: 서버 쪽은 세션 id 를 알려 주는 장치가 없다. 셸에서 `claude`/`codex` 가 실행된 시각(명령 줄 기록) 뒤에 생긴 서버의 기록 파일을 SFTP 로 찾고(다른 칸이 잡은 파일 제외), 애매하면 고르게 한다. 따라 읽기는 서버 파일 실시간 보기(`logTail.js`)처럼 `stat` 한 번 → 늘어난 부분만, 탭의 SFTP 채널 하나를 함께 쓴다. 보내기는 서버 셸의 화면을 앱의 xterm 으로 읽어 같은 규칙.

## 바꿀 파일 (1단계)

- 새로 만듦: `src/agentChat/{transcripts,claudeTranscript,codexTranscript,watch,ipc}.js`(+테스트), `components/AgentChat/{AgentChatCover,AgentChatMessage,AgentChatToolCard,AgentChatComposer}.tsx`, `AgentChat.css`, `stores/agentChatStore.ts`(셸 id → 보기·항목), `lib/agentChatItems.ts`(항목 합치기, +테스트), `e2e/specs/local-agent-chat.js`.
- 고침: `main.js`(IPC 묶음, `MAIN_RUNTIME_DIRECTORIES` 에 `agentChat`), `src/preload.js`, `types/index.ts`, `src/ipc/agentInboxWake.js`(입력칸 확인을 함수로 빼기), `src/agentHistory/boundedRead.js`(시작 위치), `LocalTerminalTab.tsx`(덮는 층), 칸 우클릭 메뉴, `shortcutsStore.ts`, 명령 팔레트, `PaneLayoutBadge`/`PaneMap`, `CLAUDE.md`.

## 시험

- 단위: Claude·Codex 줄 해석(실제 기록에서 내용을 지운 작은 가짜 파일: 같은 `message.id` 합치기, 도구 호출·결과 짝, 주입 입력 빼기, 모르는 줄 종류, 잘린 마지막 줄), 따라 읽기(늘어남·줄어듦·파일 바뀜·1MB 넘김), 보내기 판정(에이전트 없음·확인 대기·입력칸 없음·입력칸 비어 있지 않음, 작업 중에는 보냄).
- 화면 테스트 `local-agent-chat`: 가짜 에이전트(`localAgentApp.js`)가 기록 파일에 줄을 쓰게 하고, 칸 둘을 모두 채팅으로 바꿔 각자 자기 대화만 그리는지, 입력창에서 보낸 글이 그 셸의 입력칸에 들어가 Enter 가 가는지, 에이전트를 끝내면 입력창이 잠기는지, 칸을 탭으로 빼도 채팅 보기가 따라가는지, 잠그면 대화가 지워지는지 본다.

## 구현 전에 확인할 것

- Claude 상태 줄을 붙이지 못한 경우(사용자가 `--settings` 를 직접 준 경우 등)의 세션 id: 셸 폴더의 기록 파일 중 그 에이전트가 시작된 뒤 생긴 것으로 찾을지, 고르게 할지.
- Codex 기록의 생각(`reasoning`)이 암호화돼 있어 보여 줄 수 없는지.
- Claude 확인 대기 화면의 실제 모양(2단계용): CLI 를 pty 로 띄워 기록한다 (`docs/fix/2026-11-19-claude-agent-status-always-idle.md` 의 방법).
- 채팅 보기에서 이미지 붙여넣기(Claude 는 터미널에서 Ctrl+V 이미지 지원)를 1단계에 넣을지.

- Codex 가 작업 중일 때 붙여 넣고 Enter 를 보내면 대기열에 들어가는지(다음 차례에 읽는지), 지금 작업에 끼어드는지. 실제 CLI 로 기록해 본다.
- 작업 중인 Claude 의 입력칸 모양(스피너 줄이 입력칸 위에 있을 때 `composer` 판정이 그대로 맞는지).

## 진행 (1단계)

- [x] main: `src/agentChat/` (`chats.js` 따라 읽기, `claudeTranscript.js`·`codexTranscript.js` 줄 해석, `items.js` 항목 모양과 자르기, `ipc.js`), 테스트 24개
- [x] 보내기: `agentInboxWake.js` 의 `submitText` (입력칸 확인 → 붙여넣기 → 그려진 것 확인 → Enter), `localShell.js` 의 `chatSend`·`interruptAgent`·`agentOf`, 테스트 6개
- [x] 화면: `components/AgentChat/AgentChatCover.tsx`·`AgentChat.css`, `stores/agentChatStore.ts`, `lib/agentChatItems.ts`·`lib/shortcutMatch.ts`(+테스트), `LocalTerminalTab.tsx`(덮는 층, 우클릭 `채팅으로 보기`, 터미널 안의 단축키), 단축키 목록 `toggle-agent-chat`, 잠그면 `clearAll`
- [x] 화면 테스트 `local-agent-chat` 작성 (`e2e/support/agentChatApp.js`: 대화 기록 폴더를 시험 프로필 안으로)
- [x] 화면 테스트 실행: `local-agent-chat` 20개 통과. 함께 돌린 `local-agent-usage` 통과 (칸 아래 사용량 줄 간격 규칙을 `.local-terminal-stage` 로 옮김). `local-split` 은 사이드바 버튼이 새 탭으로 날아가는 확인 하나, `local-agent-messages` 는 메시지 합치기 확인 하나가 실패: 둘 다 다른 세션이 커밋하지 않고 고치는 중인 파일(`LocalTerminalList.tsx`, `AgentMessages.tsx`)의 동작이라 이 작업과 따로 본다

## 구현하며 정한 것 (설계와 다른 점)

- 채팅으로 볼 수 있는 셸은 main 이 에이전트를 아는 셸이다: ezShell 이 띄운 에이전트, 또는 셸에 직접 입력해 메시지 MCP 로 그 셸에 묶인 에이전트 (`localShell` 의 `entry.agent`·`entry.inbox`). 그 밖의 셸은 메뉴가 비활성이다.
- Claude 의 기록 파일은 상태 줄이 알려 준 세션 id 로만 찾는다 (사용자가 `--settings` 를 직접 줘서 상태 줄이 없으면 "대화가 시작되면 여기에 보입니다" 에 머문다). 폴더 이름은 셸 폴더에서 계산하고(`claudeFolderName`: 영숫자 말고는 `-`), 없으면 모든 프로젝트 폴더에서 그 id 의 파일을 찾는다.
- Codex 는 `item_completed` 만 읽는다 (사용자 질문·답·명령·파일 수정·MCP 호출·계획이 모두 있다). 이 이벤트가 없는 옛 Codex 는 1단계에서 보이지 않는다. 생각(`Reasoning`)은 이 PC 의 기록에 요약이 비어 있어 그리지 않는다.
- 감시는 탭이 아니라 셸 기준이고 0.5초마다 `stat` 한 번. 셸이 닫히면 main 이 감시를 닫고 화면에 `gone` 을 보낸다.
- 목록은 줄 수만 3,000개로 제한하고 보이는 줄만 그리기는 하지 않았다 (항목이 접힌 카드라 DOM 이 작다). 넘으면 오래된 것부터 버린다.
- 사이드바 칸 배치 그림의 채팅 표시는 2단계로 미뤘다.

## 확인 질문에 채팅에서 답하기 (2026-11-20, 사용자 요청으로 2단계에서 당겨 옴)

- main 이 셸의 화면(headless xterm)에서 번호 선택지가 있는 질문을 읽는다 (`agentInboxWake.js` 의 `approvalPrompt`). 입력칸이 보일 때는 읽지 않는다 (CLI 는 질문 동안 입력칸을 감춘다: 출력의 번호 목록을 질문으로 오인하지 않게). 질문 줄(`?` 로 끝남), 그 질문이 무엇에 관한 것인지(Claude 는 대화 상자 위 선까지, Codex 는 질문 줄까지), 선택지(1~9, 차례대로)와 지금 고른 것. 터미널이 접은 줄(`isWrapped`)은 이어 붙인다 (좁은 칸에서 긴 선택지가 접혀 질문을 놓쳤다).
- 화면에는 감시 틱마다 바뀐 경우만 `approval` 로 간다. 채팅 아래에 질문 카드가 뜨고 입력창은 감춘다. 버튼이나 숫자 키로 고른다.
- 바꾸면 안 되는 것 (답하기, `answerApproval`): 화면이 아직 사용자가 본 바로 그 질문(질문·선택지가 같음)일 때만 그 번호 키를 보낸다. 0.6초 뒤 같은 질문이 그대로 있고 선택이 그 번호로 옮겨 가 있을 때만 Enter 를 보낸다 (번호만으로 선택만 움직이는 CLI). 그 사이 질문이 한 번이라도 사라졌으면 Enter 를 보내지 않는다: 같은 질문이 다시 뜬 것은 새 질문이고, Enter 가 그것까지 승인한다.
- 읽지 못한 확인 대기(번호 선택지가 없음)는 예전처럼 "터미널에서 답해 주세요".
- 시험: 단위 7개(Claude·Codex 모양, 입력칸이 있을 때, 선택만 움직일 때 Enter, 사라졌다 다시 뜰 때 Enter 없음, 바뀐 질문 거부, 좁은 칸), 화면 테스트 `local-agent-chat` 에 질문 카드·답하기 4개.

## 답변의 링크 열기 (2026-11-20, 사용자 요청)

- 채팅의 Markdown 은 `renderChatMarkdown` 으로 그린다: 이 PC 경로 링크(`C:/...`, `C:\...`, `/...`, `file:///...`)도 링크로 남긴다 (파일 창의 Markdown 보기는 그대로 http·mailto 만). 네트워크 경로(`\\host`, `//host`)는 링크가 되지 않는다.
- 링크를 누르면 메뉴: 파일·폴더는 `ezShell 에서 열기`(서버 파일 창과 같은 창, 텍스트는 편집기·이미지·PDF 는 미리보기, 폴더는 안 됨) / `파일 탐색기에서 열기`(`shell.showItemInFolder`, 실행하지 않음) / `경로 복사`, 웹 주소는 `브라우저에서 열기` / `주소 복사`.
- 바꾸면 안 되는 것: main 은 그 칸의 대화에서 에이전트 답변에 나온 링크만 연다 (`chats.js` 가 보낸 답변의 링크를 기억, `links.js` 의 `linkKeysIn`·`linkTarget`, IPC `agent-chat-open-link`). 사용자 입력에 있던 경로나 창이 지어낸 경로는 거부한다. 경로는 `isLocalFilePath` 를 지나야 하고(네트워크 경로를 열면 Windows 가 그 호스트로 자격 증명을 보낸다), 실제 경로로 푼 뒤 연다. 파일을 `shell.openPath` 로 열지 않는다 (실행 파일이 실행된다).
- 작업 공간의 파일 열기(`local-file-open`)는 열린 셸의 폴더 안만 받지만, 이 경로는 대화에 나온 파일이면 폴더를 가리지 않는다 (`remoteFileIpc.openLocalFile`): 사용자가 고른 링크이고, 예: `%APPDATA%\ezshell\mcp.json`.
- 시험: `links.test.js` 3개, `chats.test.js` 링크 기억 1개, `markdownRender.test.ts` 2개, 화면 테스트 `local-agent-chat` 4개.
