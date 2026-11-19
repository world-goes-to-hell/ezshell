# 에이전트 세션 기록 (오른쪽 패널)

날짜: 2026-11-19
상태: 1단계 구현 완료 (2026-11-19 승인, 커밋 전)

**바뀐 점 (같은 날, 사용자 요청)**: MCP 활동과 한 패널의 두 탭으로 묶지 않고 나눴다. MCP 활동은 원래의 단독 겹침 패널로 되돌렸고, 대화 기록은 로컬 셸 작업용 패널 `작업 공간`의 첫 구역(`대화 기록`)이 되었다. 작업 공간은 터미널 옆에 자리를 차지하는 고정 칸이다 (겹침 패널은 터미널을 누르면 밀려나서, 앞으로 넣을 디렉터리 구조·Git 기록을 보며 작업하기에 맞지 않았다). 아래 "화면" 절의 오른쪽 패널·탭 설명은 이 변경 전의 것이다.

## 목표

이 PC 에서 실행했던 Claude Code·Codex 세션을 오른쪽 패널에 목록으로 보여 주고, 고른 세션을 로컬 터미널 탭에서 이어서 실행한다.
Orca(MIT, https://github.com/stablyai/orca)의 "Agent Session History" 를 참고한다. 문서: `docs/site/content/docs/agents/session-history.mdx`.

Orca 의 동작 요약: 에이전트 CLI 가 디스크에 남긴 대화 기록 파일을 읽어서 목록을 만든다. 따로 수집하는 장치는 없다. 행을 누르면 세부 정보(폴더, 브랜치, 모델, 첫 질문, 최근 대화)를 보여 주고, Resume 은 그 폴더에서 새 터미널을 열고 `claude --resume <id>` / `codex resume <id>` 를 실행한다.

## 결정 사항

- **자리**: MCP 활동 패널과 같은 오른쪽 자리에 둔다. 패널 머리에 탭 두 개(`에이전트 기록` / `MCP 활동`)를 둔다. MCP 활동은 모니터링용이라 늘 펼쳐 둘 필요가 없어서 자리를 함께 쓸 수 있다 (사용자 의견).
- **1단계 에이전트**: Claude Code 와 Codex 만 다룬다 (ezShell 의 로컬 터미널이 실행하는 둘). Orca 가 지원하는 나머지 16종은 나중에 판단한다.
- **범위**: `이 프로젝트` / `전체` 두 가지. `이 프로젝트` 는 지금 앞에 있는 로컬 터미널 탭의 폴더가 속한 Git 저장소(워크트리 포함)이고, 저장소가 아니면 그 폴더 아래다. 로컬 터미널 탭이 앞에 없으면 `전체` 로 시작한다.
- **이어서 실행**: 새 로컬 터미널 탭을 그 세션의 폴더에서 열고 재개 명령을 실행한다. 에이전트 메시지(`ezshell-cli-mcp`) 설정은 새로 띄울 때와 같이 붙인다.
- 원격(SSH) 서버의 에이전트 기록은 1단계에서 다루지 않는다.

## 화면

- 여는 경로: 상태 줄의 `에이전트 기록` 버튼(항상 보임), 명령 팔레트 `에이전트 기록 보기`. 지금의 `MCP 활동` 상태 줄 버튼은 그대로 두고, 누르면 같은 패널의 MCP 탭이 열린다.
- 패널 동작은 지금 MCP 패널과 같다: 뒤의 셸을 누르면 오른쪽 끝 세로 탭으로 접히고, Esc 로 닫는다. 접힌 세로 탭에는 고른 탭의 이름을 쓴다.
- 기록 탭의 구성:
  - 머리: 검색칸(제목·폴더·브랜치·모델), 범위 선택, 새로고침, `N개 표시 · 전체 M개`.
  - 목록: 최근 수정 순. 행마다 에이전트 표지(Claude/Codex), 제목, 폴더의 마지막 이름, 브랜치, 수정 시각(`3분 전`).
  - 행을 누르면 그 자리에서 펼쳐서 세부 정보를 보여 준다: 전체 폴더 경로, 모델, 첫 질문 전체(복사 버튼), 최근 대화 몇 턴, 그리고 `이어서 실행` · `재개 명령 복사` · `세션 ID 복사` · `폴더 열기`(탐색기).
- MCP 활동의 `새 창으로 열기` 창은 지금처럼 MCP 활동만 보여 준다.

## main 쪽 설계 (`src/agentHistory/`, 새 폴더)

- `claude.js`: `$CLAUDE_CONFIG_DIR` 또는 `~/.claude` 의 `projects/*/*.jsonl` (최상위 파일만, 하위 에이전트 폴더 제외).
- `codex.js`: `$CODEX_HOME` 또는 `~/.codex` 의 `sessions/**/rollout-*.jsonl`. 첫 줄 `session_meta` 에 `id`·`cwd`·`git`·`cli_version` 이 있다.
- `scan.js`: 두 목록을 합친다. 파일마다 앞부분(최대 256KB: 세션 ID, 폴더, 브랜치, 모델, 첫 질문)만 읽고, 경로·크기·수정 시각이 같으면 기억해 둔 요약을 쓴다. 최근 대화는 세부 정보를 열 때 그 파일의 끝부분(최대 256KB)만 읽는다.
- `ipc.js`: `agent-history-list`(요약 목록), `agent-history-detail`(키 하나), `agent-history-resume`(키 하나 → 새 로컬 셸). 모두 본창에서 온 것만 받고 잠긴 동안 거부한다.
- 로컬 셸: `localShell.js` 의 `open` 이 `resume: { agent, id }` 를 받아 실행 인자에 재개 옵션을 더한다 (`claude --resume <id>`, `codex resume <id>`). Codex 의 `-c` 설정과 `--no-daemon` 확인은 지금 방식을 그대로 쓴다.

## 바꾸면 안 되는 것 (보안·부담)

- 대화 기록에는 비밀번호·토큰이 섞일 수 있다. 파일은 main 만 읽고, 화면에는 요약과 열어 본 세션의 최근 대화만 보낸다. 대화 내용은 디스크에 따로 쓰지 않는다 (기억은 메모리에만).
- MCP 도구, 휴대폰 원격 접속, 에이전트 메시지로는 이 목록을 내보내지 않는다.
- 화면은 경로·명령·세션 ID 를 보내지 않고 main 이 만든 목록의 키만 보낸다. 재개 명령은 main 이 그 키로 찾은 값으로 만든다. 세션 ID 는 형식(UUID 등)을 검사하고, 폴더는 `requireLocalDirectory` 로 실제로 있는지 본다. 폴더가 없어졌으면 이어서 실행 대신 안내를 보여 준다.
- 파일 전체를 읽지 않는다 (이 프로젝트의 Claude 기록 4개가 197MB). 줄 하나가 아주 길 수 있으므로 읽는 바이트에 상한을 둔다. 목록 갱신은 패널을 열 때와 새로고침을 누를 때만 한다 (상시 감시하지 않는다).
- 화면 설정 백업(`UI_SETTING_ENTRIES`)에는 범위·고른 탭 같은 보기 값만 넣을 수 있고, 폴더나 세션 ID 는 넣지 않는다.

## 바꿀 파일

- 새로 만듦: `src/agentHistory/*.js`(+테스트), `components/RightPanel/RightPanel.tsx`(탭과 접기), `components/AgentHistory/AgentHistoryPanel.tsx`, `AgentHistoryRow.tsx`, `AgentHistory.css`, `lib/agentHistory.ts`(검색·범위 계산, +테스트), `stores/rightPanelStore.ts`, `e2e/specs/local-agent-history.js`.
- 고침: `main.js`(IPC 묶음 등록, `MAIN_RUNTIME_DIRECTORIES`), `src/preload.js`, `types/index.ts`, `src/localShell.js`(재개 인자), `App.tsx`(`handleOpenLocalTerminal` 에 재개 전달), `Mcp/McpActivityIndicator.tsx`·`McpActivityPanel.tsx`(패널 틀을 RightPanel 로 옮김), `stores/mcpActivityStore.ts`(열림·접힘 상태를 rightPanelStore 로), 상태 줄, 명령 팔레트, `CLAUDE.md`.

**다른 세션과 겹치는 파일**: 2026-11-19 현재 다른 세션이 커밋하지 않은 변경이 `src/localShell.js`, `App.tsx`, `SettingsModal.tsx`, 사이드바 파일, `CLAUDE.md`, `package.json` 에 있다. `localShell.js` 와 `App.tsx` 는 그 변경이 커밋된 뒤에 고치거나, 고칠 때 그 세션과 먼저 맞춘다.

## 시험

- 단위: Claude·Codex 기록 파서(작은 가짜 파일: 정상, 앞부분이 잘린 줄, 아주 긴 줄, 폴더 없는 세션), 기억(수정 시각이 같으면 다시 읽지 않음), 재개 인자(Windows·그 외), 검색·범위 계산.
- 화면 테스트 `local-agent-history`: 임시 프로필의 `CLAUDE_CONFIG_DIR`·`CODEX_HOME` 에 가짜 기록을 두고, 목록·검색·범위·세부 정보를 확인한 뒤 `이어서 실행` 이 그 폴더의 로컬 터미널 탭을 열고 재개 명령을 넘기는지 본다 (가짜 `claude`/`codex` 실행 파일을 PATH 앞에 둔다. `localAgentFixture.js` 와 같은 방식).

## 구현 전에 확인할 것

- Claude 기록에 사용자가 붙인 제목(`/rename` 등)이 어떤 줄로 남는지. 없으면 첫 질문을 제목으로 쓴다.
- `codex resume <id>` 에 `-c` 설정을 함께 줄 때의 순서 (`codex -c ... resume <id>` 인지).
- Claude 의 다른 도구(claude-mem 관찰 세션 등)가 남긴 기록을 걸러야 하는지. 1단계는 메시지가 없는 세션만 숨긴다.

## 진행

- [x] 계획 승인
- [x] main: 파서·스캔·IPC (+단위 테스트 13개)
- [x] 로컬 셸 재개 인자 (`localShellResume.test.js` 4개)
- [x] 오른쪽 패널 틀과 MCP 탭 이전 (`rightPanelStore`, MCP 패널은 내용만)
- [x] 기록 탭 화면 (`lib/agentHistory.ts` 테스트 9개)
- [x] 화면 테스트 `local-agent-history` (17개 확인), CLAUDE.md

## 확인한 것 (구현 전 확인 항목의 답)

- Claude 제목: 사용자가 붙인 이름은 `agent-name` 줄(`agentName`), 자동 제목은 `ai-title` 줄(`aiTitle`)로 파일 곳곳에 반복해서 남는다. 끝부분의 가장 최근 값을 쓴다.
- Codex: `codex resume [OPTIONS] [SESSION_ID]` 가 `-c`·`--no-daemon` 을 받는다. 그래서 `codex resume <id> --no-daemon -c ...` 순서로 넣는다. 오래된 기록은 `.jsonl.zst` 로 압축된다 (이 PC 에서 25개 중 16개).
- 첫 질문을 못 찾는 세션: 대부분 질문 없이 끝난 빈 세션이었다(이 PC 에서 20개, 자동화 도구의 `ping` 세션 포함). 이어서 진행한 큰 Claude 세션은 첫 질문이 24MB 지점에 있어서, 끝부분의 마지막 질문을 미리보기로 쓴다.
- 화면 테스트에서 `element.click()` 은 키보드 포커스를 옮기지 않아, 그 뒤의 CDP Esc 가 패널에 닿지 않았다. 실제 포인터 입력(`driver.click`)으로 누르면 닿는다.
