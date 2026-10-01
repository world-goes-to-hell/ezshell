# execFile 오류 메시지에는 명령줄 전체가 들어간다 (비밀을 인자로 넘기지 말 것)

## 증상
MCP 자동 설정에서 사용자 환경 변수를 `execFile('setx', ['EZSHELL_MCP_TOKEN', token])` 으로 설정했다.
setx 가 실패하면 `err.message` 를 그대로 화면에 띄웠는데, 그 메시지가 `Command failed: setx EZSHELL_MCP_TOKEN <토큰>` 이었다.
결과 패널에 토큰이 평문으로 남았다. 또한 명령줄 자체도 Windows 프로세스 생성 감사 로그(4688, Sysmon 1, EDR)에 남는다.

## 왜 바로 못 잡았나
테스트의 가짜 execFile 이 `new Error('access denied')` 를 던졌다. 실제 Node 의 오류 형식(명령줄 포함)을 흉내 내지 않아 통과했다. 코드 리뷰에서 발견했다.

## 해결
- 비밀은 stdin 으로 넘긴다: PowerShell `[Console]::In.ReadLine()` → `[Environment]::SetEnvironmentVariable(name, value, 'User')` (setx 처럼 설정 변경을 알림).
- 실행 파일은 절대 경로 (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`). 이름만 주면 현재 폴더의 같은 이름 exe 가 먼저 잡힐 수 있다.
- 오류는 `err.code` / `err.killed` 로 정해진 문구만 만든다. `err.message` 는 쓰지 않는다.
- 테스트는 실제 형식의 오류(`Command failed: <명령줄>`)를 쓰고, 결과에 토큰이 없는지 확인한다.

## 같이 겪은 도구 함정 (이 세션)
- Write/Edit 도구에 `'\uFEFF'` 처럼 `\u` 이스케이프를 쓰면 실제 BOM 문자로 바뀌어 저장됐다. 소스에 보이지 않는 문자가 생긴다. `String.fromCharCode(0xfeff)` 를 쓴다.
- Bash heredoc(`<<'EOF'`) 으로 JS 를 쓰면 `'d:\\work'` 의 `\\` 가 `\` 하나로 줄어 문법 오류가 났다. 백슬래시가 든 코드는 Edit 도구로 넣는다.
- vitest 의 "Failed to parse source" 는 위치를 안 알려 준다. `require('esbuild').transform(src, { loader: 'js' })` 로 줄/열을 찾는다.
