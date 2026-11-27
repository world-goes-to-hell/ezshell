# 메시지 알림 감시기의 "사용자 입력"에는 터미널 자동 응답이 섞인다

## 무엇이 어려웠나

같은 날 "알림이 두 번 들어감"을 고쳐 배포했는데, 새 Codex 세션에서 다섯 번이 들어갔다. 가짜 화면 시험과 앱 밖의 실제 Codex 재현(포커스 보고 없이)은 모두 정상이어서 원인이 바로 보이지 않았다.

- 1분 사이에 다섯 번이 붙었다는 사실은 Codex 기록(`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 의 사용자 메시지 시각, `~/.codex/logs_2.sqlite`)으로 확인했다. 앱이 쓴 버전은 `%APPDATA%/my-ssh-client/last-version.json` 에 있다.
- 결정적인 차이는 "앱의 탭에는 xterm 이 붙어 있다"였다. Codex 가 `ESC[?1004h` 로 포커스 보고를 켜면, 창을 옮길 때마다 xterm 이 `ESC[I`/`ESC[O` 를 PTY 로 보낸다. 이 응답은 사용자 키와 같은 길(`localShell.write` → `inbox.userInput`)을 지난다.

## 기억할 것

- `userInput()`·`setComposing()` 처럼 "사용자가 손댔다"고 판단하는 곳에는 키가 아닌 터미널 응답(포커스 보고, DA, OSC 색 응답, DECRPM 등)이 들어올 수 있다. 상태를 지우는 판단은 `TERMINAL_REPORTS` 를 거른 뒤에 한다.
- 앱 밖 재현 도구에는 렌더러의 xterm 이 없다. 포커스 보고, 조회 응답, 칸 크기 변경처럼 렌더러가 만드는 입력은 따로 흉내 내야 한다.
- 재현 도구 구성 (scratchpad 에 두었다가 지워질 수 있음): node-pty 로 `node <npm>/@openai/codex/bin/codex.js --no-daemon -c mcp_servers.ezshell-cli-mcp.command=<없는 명령> ...CODEX_HOOK_ARGS` 를 띄운다. 출력은 `createAgentInboxWake` 의 `writeOutput` 에 넣는다. 상태는 OSC 7501(`state=idle/working`)과 창 제목으로 흉내 낸다. 감시기의 `write` 에서 붙여넣기만 PTY 로 보내고 `\r` 은 기록만 한다 (모델 호출 없음). 메시지 MCP 명령을 바꾸지 않으면 실행 중인 앱에 에이전트로 붙는다.
- Codex 0.172 는 시작할 때 훅을 부르지 않는다 (SessionStart 도 첫 차례 때). 시작 직후 상태는 OSC 7501 로 `idle` 이 온다.

관련 수정: `docs/fix/2026-11-27-wake-notice-repasted-on-focus-reports.md`, `docs/fix/2026-11-27-wake-notice-pasted-twice.md`, `docs/fix/2026-11-25-codex-inbox-notice-left-in-composer.md`
