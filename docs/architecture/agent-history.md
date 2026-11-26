# 작업 공간의 에이전트 대화 기록

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

## Work Panel and Agent Session History (작업 공간의 대화 기록)

상태 줄의 `작업 공간`(또는 명령 팔레트 `작업 공간 열기`)이 로컬 셸 작업용 패널을 연다. 지금 구역은 `대화 기록` 하나이고 앞으로 디렉터리 구조·Git 기록이 더해진다. 대화 기록은 이 PC 에서 실행했던 Claude Code·Codex 세션을 보여 주고, 행을 펼쳐 첫 질문·최근 대화를 보거나 `이어서 실행` 으로 그 폴더의 로컬 터미널 탭에서 재개한다 (`claude --resume <id>`, `codex resume <id>`, 에이전트 메시지 설정은 새로 띄울 때와 같이 붙는다). Orca(MIT)의 Agent Session History 를 참고했다. 설계: `docs/plan/2026-11-19-agent-session-history.md`.
- 작업 공간(`Workspace/WorkspacePanel.tsx`, 상태 `stores/workspacePanelStore.ts`, 계산 `lib/workspacePanel.ts`)은 `.app-main` 줄에서 본 영역(`main`) 오른쪽에 붙는 고정 칸이다. 터미널을 덮지 않고 옆에 자리를 차지하므로 터미널에서 작업하는 동안에도 열려 있다. 왼쪽 가장자리를 끌어 폭을 바꾸고(280~720px, 창 폭의 절반까지, 두 번 누르면 380px), 열림·폭은 `localStorage` 의 `workspacePanel`. 대화 기록의 범위는 앞에 있는 탭을 따라간다 (탭이 바뀌면 목록을 다시 읽는다. main 이 바뀐 파일만 읽어 가볍다). Zen 모드에서는 그리지 않는다. MCP 활동은 원래의 단독 겹침 패널이다.
- 바꾸면 안 되는 것: 폭 끌기는 포인터 붙잡기(`setPointerCapture`)가 아니라 누르는 순간 창에 건 `pointermove`/`pointerup` 으로 한다. 손잡이가 6px 라 포인터가 바로 벗어나는데, 붙잡기가 잡히지 않아 끌어도 폭이 바뀌지 않았다 (화면 테스트에서 확인).
- main 은 `src/agentHistory/`: Claude 는 `$CLAUDE_CONFIG_DIR`(없으면 `~/.claude`)의 `projects/*/<세션 id>.jsonl`(하위 에이전트 폴더 제외), Codex 는 `$CODEX_HOME`(없으면 `~/.codex`)의 `sessions/YYYY/MM/DD/rollout-*.jsonl` 과 압축된 `.jsonl.zst`(Node 의 zstd 로 푼다). 제목은 Claude 의 `agent-name`(사용자가 붙인 이름) → `ai-title` → 첫 질문, Codex 는 `session_index.jsonl` 의 이름 → 첫 질문. Claude 의 첫 질문은 `isMeta`·`<command-…>` 같은 주입 입력을 뺀 사용자 입력이고, Codex 는 `item_completed` 의 `UserMessage` 다 (`response_item` 의 사용자 메시지에는 CLI 가 넣은 맥락이 섞인다. 옛 버전만 그쪽에서 `<`·`#` 로 시작하지 않는 것을 읽는다).
- 바꾸면 안 되는 것 (보안): 대화 기록에는 비밀이 섞일 수 있다. 파일은 main 만 읽고 화면에는 요약과 펼친 세션의 최근 대화만 보낸다 (파일 경로는 보내지 않는다). 화면은 목록의 키(`claude:<id>`)만 돌려보내고, `이어서 실행` 은 `local-shell-open` 의 `resume` 에 그 키를 넣는다: main 이 마지막 목록에서 찾은 폴더·에이전트·세션 id 로 셸을 열고, 화면이 보낸 `cwd`·`agent` 는 무시한다. 세션 id 는 셸 명령줄에 들어가므로 `localShell.js` 의 `resumeArgs` 가 UUID 형식만 받는다. 재개·폴더 열기는 이 PC 의 경로(`localKeyPath.js` 의 `isLocalFilePath`)인 폴더만 받는다 (`\\host\share` 를 확인하는 순간 Windows 가 그 호스트로 자격 증명을 보낸다). `agent-history-*` IPC 는 본창에서, 잠금 해제 상태에서만 받고, 잠그면 읽어 둔 요약을 지운다 (`history.clear()`, 진행 중이던 목록 읽기도 버린다). 작업 공간의 기록 목록·검색·원본 파일·재개는 MCP·원격 접속·에이전트 메시지에서 제공하지 않는다.
- 바꾸면 안 되는 것 (부담): 파일 전체를 읽지 않는다 (이 PC 의 Claude 기록 4개가 197MB). 앞에서부터 줄 단위로 읽다가 필요한 값을 찾으면 멈추고(상한 2MB, 1MB 넘는 줄은 건너뜀), 끝은 64KB(첫 질문을 못 찾은 세션만 1MB)를 읽는다. 크기·수정 시각이 같은 파일은 기억해 둔 요약을 쓴다. 최근 500개 파일만, 목록은 패널의 기록 탭을 볼 때와 새로 고침을 누를 때만 읽는다 (상시 감시하지 않는다). 첫 읽기 약 0.1초, 다시 읽기 0.01초 (실제 기록 75개).
- 범위: 앞에 있는 로컬 터미널 탭의 폴더(`local.cwd`, 없으면 프롬프트에서 읽은 `currentPath`)가 속한 Git 저장소와 워크트리, 저장소가 아니면 그 폴더 아래. 로컬 탭이 앞에 없으면 `전체` 만 된다. 질문이 없는 세션은 기본으로 숨긴다. 계산은 `lib/agentHistory.ts`.
- 대화에 저장된 역할을 제목 옆에 표시하고 검색에 포함한다. 대화 키와 Claude 계정으로 기존 역할 저장소를 조회하며, 사용자가 지정한 역할을 우선한다. 역할이 바뀌면 열린 목록을 갱신한다.
- 새 `src/` 폴더라서 `MAIN_RUNTIME_DIRECTORIES` 에 `agentHistory` 가 있다.

## Agent History Content Search (에이전트 기록의 대화 내용 검색)

작업 공간의 에이전트 기록 검색칸은 제목·폴더·브랜치·모델에 더해 대화 내용(사용자 질문과 에이전트 답변 본문)으로도 찾는다. 검색어가 2자 이상이면 입력이 0.4초 멈춘 뒤 main 의 `agent-history-search` 를 부르고(`AgentHistoryPanel.tsx`), 일치한 대화는 줄 아래에 찾은 부분의 한 줄 발췌(`.agent-history-snippet`, 낱말 강조)를 보여 준다. 목록 계산은 `lib/agentHistory.ts` 의 `withContentMatches`. main 은 `src/agentHistory/search.js`: 마지막 목록의 파일만, 처음부터 스트림으로 읽어 `promptText`·`legacyPromptText`·`replyText` 만 보고(도구 결과·도구 호출·주입된 문맥은 보지 않음: 비밀 값이 섞이기 쉽다), 모든 낱말이 한 대화 안에 있으면 일치. 바꾸면 안 되는 것: 파일당 압축 푼 뒤 16MB 까지만 읽고(`MAX_FILE_BYTES`), 동시 4개, 새 검색이 오거나 잠그면(`clear` 의 generation) 진행 중인 검색을 멈추고 결과를 버린다 (`history.search`). 화면에는 key 와 120자 발췌만 보낸다 (파일 경로 없음). 본창·잠금 해제 상태에서만 받고 MCP·원격 접속으로는 내보내지 않는다. 시험: `local-agent-history` 명세의 내용 검색 확인.

## Agent Session Drag (에이전트 기록의 대화를 끌어 놓아 이어서 열기)

작업 공간 에이전트 기록의 대화 줄(`.agent-history-row`)을 끌어 탭 줄·시작 화면에 놓으면 새 로컬 터미널 탭에서(`RESUME_AGENT_SESSION_EVENT`), 로컬 터미널 탭의 칸에 놓으면 포인터에 가까운 쪽 절반의 새 칸에서(빈 자리는 그대로 채움), 탭 줄의 로컬 탭에 놓으면 그 탭의 빈 자리나 가장 큰 칸 옆에서 이어서 연다 (`lib/agentSessionDrop.ts`, `hooks/useAgentSessionDrop.ts`, 표시는 `App.tsx` 의 `.agent-drop-marker`). 칸에 넣을 때는 `local-shell-open({ resume: key })` 로 셸을 먼저 연 뒤 `adoptLocalPaneShell` 로 새 칸에 넣는다 (탭 병합의 `treeWithArrival` 재사용, 로컬 탭이라 칸 수 상한 없음: `Split Panes` 절). SSH·DB 탭은 받지 않는다 (에이전트는 이 PC 에서 실행된다). 끄는 동안 `<html data-agent-drag>` 가 MCP 활동 패널(터미널 위에 겹쳐 뜬다)을 반투명·`pointer-events: none` 으로 만든다: 그 아래 칸을 겨눌 수 있게. 작업 공간은 터미널 옆에 있어 해당 없다. 처리기는 탭 병합처럼 문서의 캡처 단계에 있고, 이 끌기(전용 형식 `application/x-ezshell-agent-session`)일 때만 움직인다. 시험: `ssh-agent-drop` 명세 (가짜 기록 시작 파일 `agentHistoryApp.js`, SSH 탭 거부 확인에 시험 서버).
