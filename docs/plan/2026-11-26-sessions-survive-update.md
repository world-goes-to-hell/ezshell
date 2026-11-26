# 업데이트해도 작업 중인 셸이 끊기지 않게

작성: 2026-11-26 (사용자 요청: "앱 업데이트 받을때 작업중인 세션 중단되지 않도록 하는 기능")

상태: 1단계 구현 끝 (2026-11-26), 사용자 PC 의 실제 업데이트 시험 남음. claude-1(개발A)과 claude-2 가 나눠서 했다.

## 지금
업데이트를 설치하기 직전에 로컬 셸의 프로세스 트리를 모두 끝낸다 (`closeAll({ killTrees: true })`, `docs/architecture/app-updates.md`). 다시 켜면 탭을 다시 열고 Claude·Codex 는 `--resume` 으로 대화만 이어 간다. 돌던 명령(개발 서버, 빌드, 에이전트가 처리하던 차례)과 화면 내용은 잃는다.

## 방향
- **세션 보관 프로세스:** PTY 를 앱이 아니라 별도 프로세스가 가진다. 앱은 이름 있는 파이프로 붙는다. 업데이트로 다시 켜면 새 앱이 다시 붙고, 보관 프로세스가 모아 둔 최근 출력으로 화면을 다시 그린다 (TUI 는 크기 신호로 다시 그리게 한다).
- **업데이트 재시작 때만 남는다.** 일반 종료는 지금처럼 모두 끝낸다. 새 앱이 2분 안에 붙지 않으면 보관 프로세스가 모두 끝내고 나간다.
- **보안:** 이 파이프는 셸에 바로 입력하는 경로다. 현재 Windows 사용자만 여는 파이프(DACL) + 파일로 넘기는 토큰. MCP·휴대폰에서 이 파이프로 가는 길은 열지 않는다 (CLAUDE.md 공통 보안 규칙).
- **설치 폴더를 잡지 않는다.** 보관 프로세스와, 살아남는 에이전트가 띄우는 프로세스(메시지 MCP, 훅, 상태 줄)는 설치 폴더의 `ezShell.exe`·`node-pty` 를 쓰면 안 된다. 쓰면 NSIS 가 "Failed to uninstall old application files: 2" 로 실패한다 (`docs/fix/2026-11-24-update-uninstall-failed-2.md`). 실행에 필요한 파일을 설치 폴더 밖(`%LOCALAPPDATA%\ezShell\runtime\<형식 버전>`)에 복사해 두고 그 복사본으로 띄운다. 복사는 앱 버전마다가 아니라 보관 프로세스의 통신 형식이 바뀔 때만 한다.
- Windows 먼저. SSH 연결(main 의 ssh2)은 2단계, macOS 는 그 뒤.

## 나눔
| | claude-1 (개발A): 세션 보관 | claude-2: 에이전트 연결 이어 가기 |
|---|---|---|
| 0단계 | 런타임 복사본으로 띄운 프로세스가 설치 폴더 파일을 잡지 않는지 (`release/win-unpacked` 로 파일 이동 시험), 복사본에서 `node-pty` 로 셸을 여는지 | 지금 앱을 다시 켜면 살아 있는 에이전트의 메시지 MCP·훅·상태 줄이 어떻게 되는지 조사. 설치하는 동안 훅·상태 줄이 설치 폴더의 exe 를 띄우는 경로 목록 |
| 1단계 | `src/sessionHost/` (파이프 서버, PTY 소유, 출력 보관, 토큰, 시간 제한), `localShell.js` 를 보관 프로세스에 붙이기, `runtimeCopy.js` | 메시지 MCP·훅·상태 줄을 복사본으로 띄우기, 앱이 다시 켜진 뒤 에이전트 등록(id·토큰·재연결 토큰·파이프 이름)을 이어 받기 |
| 맡는 파일 | `src/sessionHost/*`, `src/localShell.js`, `main.js` 의 종료 부분 | `src/ipc/agentMessages.js`, `agentMessageMcp.js`, `agentMessageSetup.js`, `src/agentHookReport.js`, `agentUsageReport.js` |

맞물리는 곳: `src/sessionHost/runtimeCopy.js` 의 `stableRuntime()` → `{ exe, appRoot }` (claude-1 이 만든다. claude-2 는 이 값으로 스크립트 경로를 만든다). 상대 파일을 고쳐야 하면 먼저 메시지로 알린다.

## 0단계 B 조사 (claude-2, 2026-11-26)

코드만 읽었다 (실행·설치 시험은 하지 않음). 줄 번호는 지금 main 기준.

### 지금 무엇이 앱 한 번의 실행에 묶여 있나
- **파이프 이름:** `agentMessages.js` 의 `start()` 가 실행마다 `\\.\pipe\ezshell-<randomUUID>` 를 만든다 (824행). 살아남은 CLI 는 환경 변수 `EZSHELL_AGENT_PIPE` 에 옛 이름을 갖고 있어서, 새 앱이 다른 이름으로 열면 아무 데도 닿지 않는다.
- **자격 증명은 모두 메모리:** 에이전트 토큰(`tokens`, `register()` 911행), 셸 토큰(`shellTokens`, `registerShell()` 1039행), 공유 브리지 토큰(`bridgeToken`, 67행), 재연결 자격 증명 해시(`reconnects`, 702행). 새 앱은 하나도 모른다.
- **에이전트 목록과 받은편지함도 메모리:** `agents`, `messages`, `serial`, 역할 세션 묶음(`roleSessions`). 역할만 `agent-roles.json` 에 남는다. 지금도 앱을 다시 켜면 안 읽은 메시지가 사라진다.
- **임시 폴더:** `start()` 가 `%TEMP%\ezshell-agent-XXXX` 를 만들고 `stop()` 이 지운다 (795~818행). 이 안에 `agent-mcp.json`·`agent-wake-mcp.json`·`agent-shell-mcp.json`(Claude `--mcp-config`), `agent-settings.json`(Claude `--settings`: 상태 줄·훅), `antigravity-settings.json`, `antigravity-status.cmd`, Codex 훅 승인 파일, PATH 에 붙인 `ezshell.cmd` 가 있다. CLI 가 MCP 를 다시 띄울 때(`/mcp`, 연결이 끊긴 뒤) 이 파일을 다시 읽으므로, 지워지면 다시 붙을 수 없다.
- **CLI 의 환경은 바뀌지 않는다:** 위 값은 셸을 열 때 환경 변수로 들어가고(`register()`·`registerShell()`), CLI 와 그 자식은 실행 중에 새 값을 받을 방법이 없다. 그래서 이어 가려면 **새 앱이 옛 값(파이프 이름·경로·토큰)을 그대로 받아들여야** 한다.

### 앱을 다시 켜면 (세션 보관이 생겨 CLI 가 살아 있다고 가정)
| 경로 | 지금 동작 | 결과 |
|---|---|---|
| 메시지 MCP (`agentMessageMcp.js`) | 소켓이 닫히면 1·2·5·10·30초 간격으로 `connectionOptions()` 를 다시 부른다. 관리 에이전트는 환경의 `EZSHELL_AGENT_PIPE`·`EZSHELL_AGENT_TOKEN` 을 그대로 쓴다 (62~65행). | 옛 파이프로 30초마다 영원히 다시 시도한다. 파이프가 같아도 새 앱이 토큰을 모르면 "등록된 에이전트가 아닙니다". 도구 호출은 모두 "다시 연결하는 중입니다". |
| 깨우기·로컬 Claude MCP | `EZSHELL_SHELL_TOKEN` 으로 붙는다 (66~73행). | 같은 이유로 실패. |
| 일반 터미널 에이전트 (공유 브리지) | 다시 시도할 때마다 브리지 파일을 다시 읽는다 (74~94행). | 새 앱의 파이프·브리지 토큰으로 붙는다. 그러나 새 앱이 그 CLI 를 모르므로 **새 id** 를 받는다 (재연결 자격 증명 해시가 없어 같은 id 복구 불가). 받은편지함은 비어 있다. |
| 훅 (`agentHookReport.js`) | 매 이벤트마다 새 프로세스, 1.5초 안에 `EZSHELL_AGENT_PIPE` 로 `agent-event`. 실패하면 조용히 끝난다. | 보고가 모두 사라진다. 상태는 화면 판독으로 떨어진다. Stop 훅의 `stop-check` 도 실패해 작업 중 메시지 알림이 멈춘다. |
| 상태 줄 (`agentUsageReport.js`) | 매 그리기마다 새 프로세스, 같은 파이프·토큰. | 사용량 줄이 멈춘다. |
| Codex 훅 | `-c hooks...` 의 명령이 `$env:EZSHELL_CLI_EXE $env:EZSHELL_AGENT_HOOK_SCRIPT codex` (`HOOK_COMMANDS`). Codex 는 훅 명령 해시로 신뢰를 기억한다. | 훅과 같음. 명령 글자는 환경 변수뿐이라 경로가 바뀌어도 다시 승인을 묻지 않는다 (지켜야 할 점). |
| Antigravity 상태 줄 | `antigravity-status.cmd` → `EZSHELL_CLI_EXE` + `antigravityStatusReport.js`. | 임시 폴더가 지워져 명령 자체가 없어진다. |

### 설치하는 동안 설치 폴더의 파일을 여는 경로
모두 `EZSHELL_CLI_EXE = process.execPath`(설치 폴더의 `ezShell.exe`)와 `__dirname` 기준 스크립트(설치본에서는 `resources\app.asar` 안)를 쓴다. exe 를 띄우는 것뿐 아니라 **asar 안의 스크립트를 읽는 것만으로도** 설치 폴더 파일을 연다.
1. 메시지 MCP 서버 프로세스: 에이전트가 살아 있는 동안 계속 떠 있다 (관리 `agent-mcp.json`, 깨우기 `agent-wake-mcp.json`, 로컬 Claude `agent-shell-mcp.json`, Codex `-c mcp_servers.ezshell-cli-mcp.command=$EZSHELL_CLI_EXE`). **가장 큰 문제:** 살아남은 에이전트 수만큼 설치 폴더 exe 가 설치 내내 떠 있다.
2. Claude 상태 줄: 화면을 그릴 때마다 (`agentMessages.js` 40행).
3. Claude 훅: 차례 시작·도구 앞뒤·Stop·알림마다 (`CLAUDE_HOOKS`).
4. Codex 훅: 같은 이벤트마다 (`CODEX_HOOK_ARGS`).
5. Antigravity 상태 줄: `antigravity-status.cmd`.
6. `ezshell.cmd`(PATH): 에이전트가 `ezshell` 명령을 부를 때.
7. 일반 터미널 에이전트의 공유 브리지: 브리지 파일 첫 줄의 exe 를 PowerShell 이 띄운다 (`agentMessageSetup.js`). 지금은 업데이트 직전 `pauseExternalBridge()` 로 막는다.
8. 로컬 셸의 PowerShell `claude`·`codex` 함수가 새 실행에 위 값을 붙인다 (`localShell.js`).

### 제안
1. **모두 런타임 복사본으로 띄운다.** `EZSHELL_CLI_EXE` 는 `stableRuntime().exe`, 스크립트 환경 변수(`EZSHELL_AGENT_MCP_SCRIPT`·`_HOOK_SCRIPT`·`_USAGE_SCRIPT`·`EZSHELL_CLI_SCRIPT`·`EZSHELL_ANTIGRAVITY_STATUS_SCRIPT`)는 `stableRuntime().appRoot` 아래 경로. 공유 브리지 파일의 첫 두 줄도 복사본 경로로 쓴다 (그러면 `pauseExternalBridge` 의 이유가 사라진다).
   - 복사본에 필요한 것: 위 다섯 스크립트와 그것이 `require` 하는 파일(`agentMessageCli.js`, `agentHookInput.js`, `agentHookEvent.js`, `agentInboxPrompts.js`, `agentProcessParents.js`, `agentInspection.js`, `mcp/sdk.js` 와 `@modelcontextprotocol/sdk`·`zod` 등 `node_modules`). 의존 파일이 많으니 **스크립트마다 한 파일로 묶은 번들**(electron-vite 의 별도 진입점)을 복사하는 것을 권한다. claude-1 의 `runtimeCopy.js` 가 이 번들을 함께 복사해야 하므로 목록을 맞추자.
   - 형식 버전 폴더마다 복사하므로, 옛 형식으로 뜬 CLI 는 옛 폴더를 계속 쓴다. 그 폴더는 그 형식을 쓰는 셸이 하나도 남지 않을 때까지 지우지 않는다 (보관 프로세스가 알려 줄 수 있음).
2. **바뀌지 않는 이름과 경로.** 새 앱이 옛 파이프 이름으로 다시 연다.
   - 파이프 이름은 무작위 그대로(추측할 수 없게) 두되, 업데이트 재시작 때 넘겨받기 기록(아래 3)에 담아 새 앱이 같은 이름으로 `listen` 한다. 고정 이름(사용자 해시)은 쓰지 않는다: Node 의 이름 있는 파이프는 기본 보안 설명자라 이름을 아는 같은 PC 의 다른 사용자도 연결을 시도할 수 있고, 토큰 검사가 유일한 막이 된다.
   - 임시 폴더 대신 `userData\agent-runtime\` 같은 사용자 폴더에 설정·MCP 설정 파일을 두고, 업데이트 재시작 때는 지우지 않는다 (일반 종료 때만 지움). 파일 내용은 지금처럼 환경 변수 참조뿐이라 비밀이 없다.
3. **넘겨받기 기록 (업데이트 재시작 때만).**
   - 담는 것: 파이프 이름, 브리지 토큰, 에이전트 목록(id·셸 id·종류·cwd·상태·`serial`), 에이전트 토큰·셸 토큰·재연결 자격 증명의 **SHA-256 해시**(원문은 남기지 않음: 새 앱은 들어온 값의 해시를 비교), 받은편지함 메시지, 역할 세션 묶음.
   - 보관: 탭 복원 기록과 같은 방식(`src/restoreTabs.js`: 마스터 비밀번호로 암호화, 한 번 읽으면 지움, 짧은 만료). 메시지 본문에 비밀이 섞일 수 있어서다.
   - 새 앱은 잠금을 풀기 전에는 기록을 열 수 없다. 그동안 파이프는 열어 두되 모든 요청을 "잠김"으로 거절한다 (지금 잠금 규칙과 같음). 메시지 MCP 는 다시 시도하다 잠금이 풀리면 붙고, 그사이의 훅·상태 줄 보고는 버려진다 (상태는 화면 판독으로 대신함).
   - 셸 id 는 claude-1 의 세션 보관이 같은 id 로 되살려 줘야 셸 토큰 → 셸 id 연결이 맞는다. 셸 id 가 바뀌면 그 셸의 토큰은 버린다.
4. **보안상 지킬 것.**
   - 토큰 원문은 디스크에 쓰지 않는다 (해시만). 재연결 자격 증명의 만료 시각도 넘긴다.
   - 넘겨받기 기록은 업데이트 재시작에만 만들고, 새 앱이 일정 시간(보관 프로세스와 같은 2분) 안에 붙지 않으면 버린다.
   - 런타임 복사본 폴더는 현재 사용자만 쓸 수 있어야 한다 (`%LOCALAPPDATA%` 기본 ACL). 다른 사용자가 바꿀 수 있는 곳이면 그 exe 가 모든 에이전트 차례마다 실행된다.
   - 옛 런타임의 스크립트가 새 앱과 대화할 수 있도록 파이프 요청에 형식 버전을 싣고, 새 앱은 지원하는 옛 형식을 받아 준다 (모르는 형식이면 거절하고 화면 판독으로 대신).
   - MCP·휴대폰에서 셸에 입력하는 경로는 여전히 만들지 않는다 (CLAUDE.md 공통 보안 규칙).

### 복사본에 넣을 파일 (require 를 따라가 계산, 2026-11-26)
- 진입 스크립트 5개: `src/ipc/agentMessageMcp.js`, `src/agentHookReport.js`, `src/ipc/agentUsageReport.js`, `src/ipc/agentMessageCli.js`, `src/ipc/antigravityStatusReport.js`.
- 그것들이 부르는 앱 파일 7개: `src/mcp/sdk.js`, `src/ipc/agentProcessParents.js`, `src/ipc/agentInspection.js`, `src/ipc/agentHookInput.js`, `src/ipc/agentHookEvent.js`, `src/ipc/agentInboxPrompts.js`, `src/ipc/agentUsage.js`. 상대 경로(`./ipc/…`, `../mcp/…`)가 그대로 맞도록 `appRoot` 아래에 같은 구조(`src/…`)로 둔다.
- `node_modules` (메시지 MCP 만 쓴다): `@modelcontextprotocol/sdk`(1.32.2), `zod`, `zod-to-json-schema`, `ajv`, `ajv-formats`, `fast-deep-equal`, `json-schema-traverse`, `fast-uri`. 지금 `src/mcp/sdk.js` 는 HTTP 전송(`streamableHttp.js`)까지 불러서 `express`·`hono` 등이 딸려 온다. 메시지 MCP 가 stdio 만 쓰도록 `McpServer`·`StdioServerTransport`·`z` 만 부르는 작은 진입 파일을 따로 두면 위 8개로 끝난다 (실제로 stdio 경로만 불러 로드된 패키지를 세어 확인).
- 권장: 위를 파일째 복사하기보다 진입 스크립트마다 한 파일 번들(CJS, `node:` 내장만 외부)로 만들어 `appRoot` 에 두는 것. 복사할 파일이 5개로 줄고, 패키지 버전이 바뀌어도 복사 목록을 고칠 필요가 없다. 1단계 B 에서 electron-vite 에 진입점을 더해 만든다.

### 확인하지 못한 것
- Claude 가 `--settings`·`--mcp-config` 파일이 지워졌다가 같은 경로에 다시 생기면 다시 읽는지, `/mcp` 재연결 때 환경 변수를 다시 펼치는지 (실제 CLI 로 확인 필요).
- 설치 프로그램이 asar 를 읽기만 하는 프로세스도 "사용 중" 으로 막는지 (claude-1 의 0단계 A 파일 이동 시험에서 함께 보면 된다).

## 시험
- 실제 업데이트 설치는 사용자 PC 의 ezShell 을 다시 띄우므로, 마지막에 사용자 승인을 받고 한 번 한다. 그 전에는 `release/win-unpacked` 에 대한 파일 이동 시험으로 대신한다.
- 단위: 파이프 토큰 검사, 출력 보관 크기, 시간 제한으로 끝나기, 재연결 뒤 같은 셸 id.

## 0단계 A 결과 (2026-11-26)
시험 자료: scratchpad 의 `host-spike/` (`host.cjs`, `run.sh`, `parent.cjs`). `release/win-unpacked` 를 복사한 가짜 설치 폴더에 대해 했다.
- 대조: 설치 폴더의 `ezShell.exe` 로 node-pty 셸을 띄우면 설치 폴더를 옮기지 못한다 (`Permission denied`). 시험이 잠금을 잡아낸다.
- 복사본: `ezShell-sessions.exe` + `ffmpeg.dll`·`icudtl.dat`·`snapshot_blob.bin`·`v8_context_snapshot.bin` + node-pty(`lib`, `prebuilds/win32-x64`, `build/Release/conpty`), 모두 257MB. 이것으로 띄우면 셸이 도는 동안 설치 폴더를 옮길 수 있고, 셸은 계속 출력한다.
- 앱 역할의 부모가 `detached` 로 띄우고 바로 끝나도 보관 프로세스와 셸은 살아 있다.
- 바꾸면 안 되는 것 (NSIS, app-builder-lib 26.18.1 `allowOnlyOneInstallerInstance.nsh`): 설치 프로그램은 경로가 `$INSTDIR` 문자열로 **시작하는** 프로세스를 모두 끝내고, PowerShell 이 없으면 이름(`ezShell.exe`)으로 끝낸다. 그래서 복사본은
  - 이름이 `ezShell.exe` 가 아니어야 하고,
  - 경로가 설치 폴더 문자열로 시작하지 않아야 한다 (대소문자 무시, 구분자 없이 앞부분만 비교한다. `...\Programs\ezShell` 이 설치 폴더면 `...\Programs\ezShell-runtime` 도 끝난다). 설치 폴더는 사용자가 바꿀 수 있으므로(`allowToChangeInstallationDirectory`) 복사할 때 이 조건을 검사한다.
- 남은 확인: 실제 Electron main 이 띄운 경우(작업 객체로 묶이지 않는지)는 1단계 화면 시험에서 본다.

## 진행
- [x] 0단계 A: 복사본 프로세스가 설치 폴더를 잡지 않음
- [x] 0단계 B: 재시작 때 에이전트 연결 조사 (코드 조사. 실제 CLI 확인 두 가지 남음)
- [x] 1단계 A (claude-1, 커밋 전). `src/sessionHost/`(`host.js` 보관 프로세스, `client.js` 앱 쪽 연결과 node-pty 모양의 `spawn`, `runtimeCopy.js` 복사본), `localShell.js` 의 `host`·`adopt`·`handOver`, `main.js` 의 시작·종료·`beforeUpdateRestart`, `updates.js` 가 설치 전에 keep 을 기다림, 화면의 칸 배치 넘기기(`local-shell-keep-layout`)와 복원 기록의 `shellId`(되살아난 탭은 다시 열지 않음). 넘겨받은 에이전트 등록에는 `env.EZSHELL_AGENT_ID` 를 `agentsOfShell` 로 채운다(봉인된 기록이 잠금 해제 뒤에 열리므로 그때 정해짐). 시험: 단위 `sessionHost/*.test.js` 25개·`localShellHost.test.js` 5개·`restoreTabsRun.test.ts`, 화면 `local-keep-through-update`(업데이트 경로로 끝내고 다시 켜도 같은 프로세스가 계속 돌고 탭에 붙음, 강제 종료면 셸도 끝남). 패키징 확인: `release/win-unpacked` 를 복사한 가짜 설치 폴더에서 asar 안의 모듈로 복사본을 만들고(첫 복사 0.1초), 셸이 도는 동안 설치 폴더를 옮기고, 두 번째 실행이 같은 pid 의 셸을 넘겨받음 (scratchpad `host-spike/packaged.cjs`).
- [x] 1단계 B (claude-2, 커밋 전). 번들 `out/main/agent-runtime/*.js`(electron.vite `agentRuntimePlugin`, 메시지 MCP 는 stdio 전용 `src/mcp/sdkStdio.js`), `agentMessages.js` 의 `agentRuntimePaths`·`agentRuntime` 옵션(복사본이 없으면 설치 폴더 경로), 넘겨받기 `exportHandoff`·`importHandoff`·`discardHandoff`, 되살린 셸용 `adopt(kind, shellId)`(잠금 해제 전에는 마지막 상태와 종료만 기억했다가 기록이 열리면 적용)·`adoptShell`(셸 토큰은 기록과 함께 돌아오므로 새로 발급하지 않음), 토큰은 SHA-256 해시로만 넘김, 넘겨받는 동안 요청 거절(`awaitingHandoff`), `stop({ handOver })` 는 설정 파일 폴더를 남김. 봉인·열기는 `src/ipc/agentHandoff.js`(엔드포인트는 평문, 기록은 마스터 비밀번호, 24시간). `main.js`: 생성 옵션, will-quit 의 `saveAgentHandoff`, 잠금 해제 두 곳의 `restoreAgentHandoff()`. 시험 `agentHandoff.test.js` 11개, 화면 시험 `local-agent-hooks`·`local-agent-messages` 통과(번들 경로로 훅·메시지 MCP 동작). claude-1 의 `localShell.adopt` 와 맞물림 확인. 남은 것: 실제 업데이트 시험.
- [ ] 사용자 PC 에서 실제 업데이트 한 번
