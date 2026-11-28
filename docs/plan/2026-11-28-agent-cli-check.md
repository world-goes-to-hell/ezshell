# CLI 화면 판독 점검 (Claude Code·Codex 가 바뀌어도 알림·채팅이 되는지)

2026-11-28 사용자 요청: 개선 제안 2번 (1 → 3 → 2 순서의 마지막). 개발E(claude-8)·개발A(claude-2).

## 문제

`docs/fix` 81건 중 `chat-` 13, `claude-` 6, `wake-`·`codex-` 4건이 같은 뿌리다: 앱이 CLI 화면(입력칸, 창 제목 스피너, 대화 상자)을 읽어 상태를 짐작하고 그 위에 알림을 붙여 넣는다. CLI 가 업데이트되면 화면이 조금 바뀌고, 사용자가 겪은 뒤에야 안다 (예: 2026-11-28 바로작업 새 세션의 Codex 0.170 시작 경합).

## 순서

1. **점검 도구 (이번)**: 실제 CLI 를 ConPTY 로 띄워 그 출력을 앱의 판독 코드(`agentInboxWake.js`·창 제목 판독)에 그대로 넣고, 정해 둔 장면을 통과하는지 본다. 사람이 CLI 를 올린 뒤 돌린다.
2. 점검 도구로 안전망이 생긴 뒤: `agentInboxWake.js`(1,644줄)의 알림 단계를 표로 정리한 상태 기계로 나눈다. 바뀐 뒤 같은 점검이 통과해야 한다.
3. 훅으로 옮길 수 있는 판단(입력칸 비었는지 말고, 시작 완료·차례 시작)을 계속 옮긴다.

## 점검 도구 (1단계)

- `scripts/agent-cli-check.cjs` (`npm run check:agent-cli -- [claude|codex] [--no-model]`). Electron 을 node 로 띄워 앱의 `node-pty`·`@xterm/headless` 를 쓴다.
- 환경: `EZSHELL_*`·`CLAUDECODE`·`CLAUDE_CODE_*`·`NO_COLOR` 를 지운다. MCP 는 끈다 (Codex `-c mcp_servers.ezshell-cli-mcp.enabled=false`, Claude 는 `--strict-mcp-config` 에 빈 설정). 작업 폴더는 임시 Git 저장소. 모델에는 해가 없는 문장만 보낸다 (도구 없이 한 단어로 답하라). Codex 는 `-s read-only`, Claude 는 편집·셸 도구를 막는다.
- 장면 (CLI 마다):
  1. 시작: 정해진 시간 안에 입력칸을 찾는다 (`composerState() === 'empty'`). 폴더 신뢰 질문이 뜨면 그것을 판독하는지(`approvalPrompt`)도 본다.
  2. 시작 직후 알림: 시작 중에 온 받은편지함 알림이 붙고 제출된다 (2026-11-28 Codex 수정의 회귀).
  3. 쉬는 중 알림: 붙여 넣은 알림이 입력칸에 보이고(`draft`) Enter 뒤 차례가 돌고(제목 스피너) 다시 쉰다.
  4. 채팅 보내기: 앱의 채팅 경로로 한 줄을 보내 같은 흐름을 본다.
  5. Esc 멈춤: 도는 차례가 Esc 뒤 1초 안에 쉬는 제목이 된다.
  - `--no-model` 이면 모델을 부르는 3~5 를 건너뛴다 (사용량 없이 화면만).
- 결과: 장면마다 통과·실패와 걸린 시간, CLI 버전. 실패하면 마지막 화면(텍스트)과 출력 원본을 `e2e/.out/agent-cli-check/` 에 남긴다.
- 통과한 버전을 `docs/architecture/agent-chat.md` 의 "확인한 CLI 버전" 표에 적는다.
- 단위 테스트는 두지 않는다: 도구가 곧 실제 CLI 에 대한 시험이고, 판정은 앱의 판독 코드를 그대로 쓴다. 제목 규칙은 `src/ipc/agentTitleStatus.js` 로 떼어 앱(`localShell.js`)과 같은 코드를 쓴다.

## 결과 (2026-11-28)

- 도구를 만들어 돌렸다: Claude Code 2.1.332 모든 장면 통과, Codex 0.170.0 통과 (Esc 뒤 창 제목 스피너가 남는 것은 주의로 표시).
- 실측으로 고친 도구 쪽 문제: 질문 답의 Enter(`rawWrite`)는 `--no-model` 에서도 넘긴다. Claude 폴더 신뢰는 앱이 터미널로 맡기므로 도구가 `Yes` 로 옮겨 고른다 (기본 선택이 `No, exit`).

## 나누기

- 1단계(도구)는 개발E 가 혼자 만들었다 (개발A 는 그동안 3번 진단 정보 화면).
- 2단계(상태 기계로 나누기)는 사용자 확인 뒤에 정한다: 여러 에이전트가 함께 고치는 큰 파일이라, 나누는 동안 다른 변경과 겹치지 않게 동결(1번 기능)을 걸고 한다.
