# 자동 업데이트 실패 재발 (2.40.1 → 2.41.0): app.asar 잠김

작성: 2026-11-27. 앞선 기록: `2026-11-24-update-uninstall-failed-2.md`

## 증상

`재시작`으로 2.41.0 을 설치하는 중 두 창이 차례로 떴다.
1. "ezShell cannot be closed. Please close it manually and click Retry" (electron-builder `allowOnlyOneInstallerInstance.nsh`: 설치 폴더 경로로 시작하는 프로세스를 강제로 끈 뒤에도 남아 있음)
2. "Failed to uninstall old application files: 2"

2.40.1 이 남긴 진단(`%TEMP%\ezShell-install-error-101936-194739625.log`):

```
old uninstaller returned 2 (selected install scope (all))
Old install directory: C:\Program Files\My SSH Client\ezShell
Win32 32: C:\Program Files\My SSH Client\ezShell\resources\app.asar
```

설치 폴더 전체를 검사했고, 공유 위반으로 잠긴 파일은 `app.asar` 하나였다.

## 확인한 것

- `app.asar` 를 여는 것은 그 asar 안의 코드를 실행하는 Electron 프로세스다 (앱, 또는 asar 안의 스크립트를 `ELECTRON_RUN_AS_NODE` 로 실행하는 프로세스).
- **확인된 버그.** 외부 에이전트용 연결 파일(`%APPDATA%\my-ssh-client\agent-message-connection`)이 설치 폴더의 `ezShell.exe` 와 `resources\app.asar\out\main\src\ipc\agentMessageMcp.js` 를 가리켰다. 앱이 시작할 때 `enableExternalBridge()` 가 런타임 복사본이 준비되기 전에 실행되어, `agentRuntimePaths` 가 설치 폴더 쪽으로 떨어졌다. 전역 등록(`~/.claude.json`, `~/.codex/config.toml` 의 `ezshell-cli-mcp`)으로 MCP 를 띄우는 모든 Claude·Codex(다른 터미널의 것 포함)가 설치 폴더의 exe 로 MCP 를 돌렸다.
- 아닌 것 (실험·조사로 배제):
  - 세션 보관 프로세스나 그 자식이 앱의 asar 핸들을 상속받아 잡는 경우: Electron 이 asar 를 연 뒤 보관 프로세스와 같은 방식(`detached`, `stdio: 'ignore'`)으로 자식을 띄우고 앱을 끝내면, 자식이 살아 있어도 asar 의 이름을 바꿀 수 있었다 (앱이 살아 있는 동안에는 바꿀 수 없음: 시험이 민감함을 확인).
  - 보관 프로세스에 남은 에이전트의 상태 줄·훅·MCP: 런타임 복사본을 가리킨다 (복사본 경로는 보관 프로세스와 같은 커밋 `f639ec0` 에서 들어옴).
  - 실행기의 재실행: 업데이트 중에는 `pauseExternalBridge` 로 연결 파일이 한 줄이 되어, 전역 등록의 실행기는 exe 를 띄우지 않는다.
- 확인하지 못한 것: 설치 프로그램이 끈 뒤에도 남은(또는 다시 뜬) 프로세스가 무엇이었는지. 진단에 프로세스 목록이 없었고, 실패 뒤 사용자가 앱을 다시 켜 당시 프로세스는 남아 있지 않았다.

## 수정

1. `main.js`: 시작할 때 연결 파일은 `sessionHostStarting`(런타임 복사본 준비 포함) 뒤에 쓴다. 전역 등록의 MCP 는 설치 폴더 밖의 복사본에서 돌아 `app.asar` 를 잡지 않는다. 이 수정은 새 버전이 "옛 버전"이 될 때(그 버전으로 앱을 한 번 시작한 뒤)부터 효과가 있다.
2. `scripts/windows-update-diagnostics.nsh`: 옛 제거 프로그램이 2 로 끝나면, 그 순간 설치 폴더를 쓰는 프로세스(실행 파일이 설치 폴더에 있거나 명령줄이 설치 폴더를 가리키는 것)를 최대 15개 기록한다: PID, 이름, 부모 PID·이름, 시작 시각, 실행 파일 경로. 명령줄 자체는 쓰지 않는다. 이 진단은 새 설치 프로그램이 돌리므로 다음 업데이트부터 기록된다.

## 시험

- `npm run build:nsis`: 설치 프로그램이 오류 없이 만들어짐.
- 진단의 PowerShell 조회를 이 PC 에서 미리 실행해 보려 했으나, 프로세스 명령줄을 읽는 명령이라 권한 확인에서 막혀 실행하지 못했다. 다음 실패 때 기록이 비어 있으면(`(the process list could not be read: …)`) 이 조회를 먼저 본다.
