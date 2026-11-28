# 업데이트 뒤 터미널에서 직접 띄운 에이전트에게 메시지가 닿지 않음

2026-11-28 사용자 보고 (2.42.0 업데이트 직후).

## 증상

- 한 에이전트에게 "ai-mockup-mcp 담당 에이전트에게 넘겨"라고 하자 `list_agents` 로 둘(codex-19·20)만 찾았다. 사이드바의 그 작업 칸에는 셋이 보였다.
- 세 번째(claude-17)는 앱에 등록돼 있고 훅도 오는데 `list_agents` 에 없고 `send_message` 가 "메시지를 받을 실행 중인 에이전트를 찾을 수 없습니다"로 거절됐다. 그 세션의 `/mcp` 는 연결됨으로 보였다 (CLI 와 MCP 서버 사이는 연결돼 있고, MCP 서버와 앱 사이가 끊긴 것).
- codex-19·20 은 목록에 있지만 `inspect_agent` 가 `status: unknown` 이고 보낸 메시지가 입력칸에 알려지지 않았다.

셋 다 로컬 터미널에 사용자가 직접 `claude`·`codex` 를 쳐서 띄웠고(앱이 띄운 에이전트가 아님), 16:10 에 떴으며 앱은 16:23 에 업데이트로 다시 켜졌다. 앱이 띄운 에이전트(전용 토큰)는 모두 다시 붙었다.

## 원인

1. 직접 띄운 CLI 는 `attachExternalAgent` 가 셸에 `entry.agent` 와 `entry.externalAgent`(CLI pid, MCP 등록 여부)를 둔다. 업데이트의 `handOver` 는 메타에 `agent` 만 넘기고, 새 앱의 `adopt` 는 `agent` 만 되살렸다. `findAgentProcess` 는 `agent` 가 있고 바인딩이 없는 셸을 후보에서 빼므로(앱이 띄운 에이전트의 셸로 보고) 그 셸의 CLI 를 찾지 못했다.
   - 셸 토큰으로 붙는 Claude(`agent-shell-mcp.json`): `bindLocalAgent` 가 없음을 돌려줘 `watchMcp` 가 "ezShell 로컬 터미널 연결을 확인할 수 없습니다"로 거부하고, MCP 는 30초마다 다시 시도하며 끊긴 채 남았다.
   - 공용 브리지로 붙는 Codex: 셸 확인 없이 폴더로만 붙었다. 셸에 묶이지 않아 화면·훅 상태가 없고(unknown) 받은편지함 알림을 붙일 입력칸도 없다.
2. (개발D 확인) 잠금 해제가 세션 보관 프로세스보다 먼저 끝나면 `importHandoff` 가 인계받은 파이프 주소(`keptEndpoint`)를 지웠고, 그 뒤 `start()` 가 새 파이프를 골라 이미 떠 있던 CLI 의 훅·MCP 가 옛 주소로 갔다.

## 고친 것

- `localShell.js`: `handOver` 가 `external: { pid, hadMcp, mcpProcessStartedAt }` 를 넘기고(`keptExternalMeta`), `adopt` 는 그 CLI 가 살아 있으면 바인딩을 `handed` 로 되살린다(`keptExternalAgent`). `bindAgentProcess` 는 인계된 바인딩의 id 를 기록에서 찾아(`agentsOfShell`) 재연결 자격 검사(`authorizeBinding` → `authenticReconnect`)를 통과한 뒤에만 그 에이전트로 잇는다.
- 2.42.0 처럼 `external` 을 넘기지 않은 앱에서 오는 첫 업데이트: 되받은 셸의 에이전트에 바인딩이 없으면 그 셸도 후보로 두고(`keptUnbound`), 이 PTY 아래 계보에서 찾은 CLI 를 그 셸의 인계된 에이전트로 묶는다. 이때도 인계받은 재연결 자격 증명이 맞아야 하고, 거부되면 아무것도 묶지 않는다.
- `agentMessages.js`: `importHandoff` 는 `keptEndpoint` 를 지우지 않고(`start()` 가 고를 때까지 남음), 두 번째 기록은 `awaitingHandoff` 로 받지 않는다. 앱 시작 때 인계 주소로 리스너를 여는 것은 개발D 의 `main.js` 수정.
- `list_agents` 는 로컬 터미널에서 돌지만 메시지 MCP 가 없는 에이전트도 `connected: false` 로 돌려준다 (보내기는 그대로 거부). 사이드바 칩은 점선 테두리, 툴팁의 상태 줄에 `메시지 연결 없음`.

## 남는 것

- 이미 끊긴 채 도는 에이전트(이번 claude-17 등)는 이 수정이 든 앱으로 다시 업데이트할 때 위 경로로 돌아온다. 그 전에는 그 칸에서 `/mcp` 로 다시 연결하면(새 MCP 프로세스, 같은 CLI) 지금 앱의 `replacedMcpProcess` 경로로 같은 id 로 붙는다.
- 화면 시험의 가짜 에이전트가 남긴 MCP 서버 프로세스(부모가 시험 앱 `electron.exe`)가 고아로 남는 것을 봤다. 이 수정과 별개.

시험: `src/localShellExternalHandover.test.js`, `src/ipc/agentHandoff.test.js` ("listens on the handed-over pipe even when the record is opened before it starts"), `src/ipc/agentMessageList.test.js`, `src/renderer/lib/agentIdentity.test.ts`.
