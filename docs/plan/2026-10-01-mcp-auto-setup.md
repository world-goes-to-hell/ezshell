# MCP 자동 설정 버튼 (Claude Code 등록 자동화)

설정 > MCP 에 "Claude Code 자동 설정" 영역을 추가한다. 지금은 사용자가 `claude mcp add ...` 명령을 복사해 터미널에서 실행해야 한다.
버튼 한 번으로 Claude Code 설정 파일에 ezShell MCP 서버 항목을 넣는다.

## 사용자 결정 (2026-10-01)
- 범위 두 가지
  - 프로젝트: 고른 폴더의 `.mcp.json` 에 병합한다. 토큰은 파일에 쓰지 않고 환경 변수 참조 `${EZSHELL_MCP_TOKEN}` 로 쓴다 (옵션 ②). 파일을 커밋해도 토큰이 새지 않는다.
  - 전체(global): `~/.claude.json` 의 최상위 `mcpServers` (Claude Code user scope) 에 넣는다.
- 기존 항목은 보존한다. 쓰기 전에 백업한다. JSON 이 깨진 파일은 고치지 않고 거부한다. 같은 이름의 항목이 있으면 덮어쓰기 전에 묻는다.

## Claude Code 형식 (code.claude.com/docs/en/mcp 확인)
- HTTP 서버: `{ "type": "http", "url": "...", "headers": { "Authorization": "Bearer ..." } }`
- `.mcp.json` 의 `url`, `headers` 에서 `${VAR}` 가 확장된다. 변수가 없으면 확장되지 않고 경고만 뜬다.
- user scope = `~/.claude.json` 최상위 `mcpServers`, local scope = `projects["<path>"].mcpServers`.
- 우선순위는 local > project > user. 프로젝트 `.mcp.json` 서버는 처음 쓸 때 Claude Code 가 승인을 묻는다.

## 설계
### main: `src/mcp/clientSetup.js` (새 파일, fs 주입으로 테스트)
- `buildServerEntry({ port, token, useEnvToken })` → 위 형식의 항목. 이름은 기존 등록 명령과 같은 `my-ssh-client`.
- `applyServerEntry({ filePath, name, entry, overwrite, createIfMissing })`
  - 파일이 없을 때: `createIfMissing` 이면 새로 만든다 (프로젝트), 아니면 거부한다 (전체: `~/.claude.json` 이 없으면 Claude Code 를 한 번 실행하라고 안내).
  - BOM 제거 후 파싱한다. 파싱 실패, 루트가 객체가 아님, `mcpServers` 가 객체가 아님 → 쓰지 않고 거부한다.
  - 같은 이름 항목이 이미 같으면 `unchanged`. 다르고 `overwrite` 가 아니면 `conflict` (기존 url 만 돌려준다. headers 에 토큰이 있을 수 있음).
  - 쓰기: `<file>.ezshell-backup` 에 원본 복사 → 임시 파일에 쓰기 → 쓰기 직전 원본이 그 사이 바뀌었는지 다시 읽어 비교 (Claude Code 가 `~/.claude.json` 을 자주 씀) → rename.
  - 결과: `added` / `replaced` / `unchanged` / `conflict`, 백업 경로.
- 전체 설정 후 `projects.*.mcpServers` 에 같은 이름 항목이 남아 있으면 그 개수를 경고로 돌려준다 (그 프로젝트에서는 예전 등록이 먼저 쓰임).

### main: `src/mcp/tokenEnv.js` (새 파일)
- Windows 에서 `%SystemRoot%System32WindowsPowerShell1.0powershell.exe` 를 절대 경로로 실행해 `[Environment]::SetEnvironmentVariable(..., 'User')` 로 설정한다. 토큰은 stdin 으로만 넘긴다 (명령줄은 감사 로그에 남고 execFile 오류 메시지에도 그대로 들어감). 오류는 종료 코드/시간 초과/없음으로만 알린다. 다른 OS 는 `unsupported`.
- (리뷰 반영 전 초안은 `setx` 였다. 리뷰에서 토큰이 명령줄과 오류 메시지로 새는 문제가 지적되어 바꿨다.)
- 새로 여는 터미널과 Claude Code 부터 적용된다는 점을 안내한다.

### controller / ipc / preload
- `controller.setupClient({ scope, projectDir, overwrite, setTokenEnv })` 가 현재 포트와 토큰으로 위 모듈을 호출한다.
- IPC `mcp-setup-client`: 잠금 상태에서는 거부한다. 프로젝트 폴더는 main 이 폴더 선택 창을 띄워 고른다. 렌더러가 경로를 넘기지 않는다.
  덮어쓰기 확인 후 다시 호출할 때는 `reuseDir: true` 로 main 이 기억한 직전 폴더를 쓴다.
- preload `mcpSetupClient`, 타입 `McpSetupResult`.

### renderer: `McpClientSetup.tsx` (새 컴포넌트)
- 버튼 두 개: "프로젝트에 설정 (.mcp.json)", "모든 프로젝트에 설정 (~/.claude.json)".
- Windows 에서는 "환경 변수 EZSHELL_MCP_TOKEN 도 설정" 체크박스 (기본 켬, 프로젝트 설정에만 해당).
- conflict → `window.confirm` 으로 덮어쓰기 확인 → `overwrite: true, reuseDir: true` 로 다시 호출.
- 결과는 토스트로 알린다 (파일 경로, 백업 여부, 환경 변수 결과, 경고).
- 토큰을 재발급하면 전체 설정과 환경 변수를 다시 맞춰야 한다는 안내를 붙인다.

## 진행 상황
- [x] clientSetup.js + 테스트 (16)
- [x] tokenEnv.js + 테스트 (4)
- [x] controller.setupClient + 테스트 (9)
- [x] ipc `mcp-setup-client` + 테스트 (7), main.js 연결 (폴더 선택 창)
- [x] preload, 타입, McpClientSetup.tsx, mcpSetupLabels.ts + 테스트 (5)
- [x] typecheck / vitest 989 / build, 임시 프로필 + 가짜 USERPROFILE 로 전체 설정 확인 (추가, 반복 시 unchanged, 충돌 확인 후 덮어쓰기, 깨진 JSON 거부). 프로젝트 설정의 폴더 선택 창은 실제 실행으로 확인하지 못함 (단위 테스트로 대체)
- [x] CLAUDE.md MCP 절 갱신
- [x] 코드 리뷰 반영 (Important 3: 토큰이 오류 메시지/명령줄로 새는 문제 → PowerShell stdin, 프로젝트 설정도 ~/.claude.json 의 local 등록 경고. Minor: 폴더 선택 후 잠금 재확인, 빈 ~/.claude.json 거부, UTF-8 아닌 파일 거부, 백업은 원본 바이트, CRLF/BOM 유지, 정규식의 숨은 BOM 문자 제거) — vitest 1023, typecheck, build 통과
