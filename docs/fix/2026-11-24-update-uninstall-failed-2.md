# 자동 업데이트: "Failed to uninstall old application files. Please try running the installer again.: 2"

작성: 2026-11-24 (사용자 보고: 자동 업데이트 중 설치 프로그램이 이 오류 창을 띄움. 다시 시도해서 2.32.0 은 설치됨)

## 원인
- 업데이트 설치 때 옛 제거 프로그램은 설치 폴더의 파일을 하나씩 임시 폴더로 옮긴다 (electron-builder `uninstaller.nsh` 의 `un.atomicRMDir`). 다른 프로세스가 연 파일이 하나라도 있으면 멈추고 코드 2로 끝나며, 설치 프로그램은 5번 다시 시도한 뒤 이 창을 띄운다 (`installUtil.nsh` 의 `uninstallOldVersion`).
- 설치 프로그램은 시작할 때 설치 폴더에서 실행된 프로세스를 강제로 끈다. 그런데 그 폴더의 `ezShell.exe` 는 앱 말고도 늘 여러 개 돌고 있었다: 메시지 MCP(`ezshell-cli-mcp`) 서버다. Claude Code·Codex 가 MCP 를 띄울 때마다 `ezShell.exe` 를 `ELECTRON_RUN_AS_NODE` 로 실행한다 (조사 때 15개 중 11개). 실행 중인 `ezShell.exe` 는 `app.asar`·`icudtl.dat` 를 공유 삭제 없이 열어서 옮기지 못하게 한다.
- 이 프로세스를 다시 띄우는 쪽이 둘 있다.
  1. ezShell 로컬 셸의 에이전트: 앱이 끝날 때 `pty.kill()` 은 콘솔의 프로세스를 비동기로 끈다 (node-pty `windowsPtyAgent.kill` 의 `_getConsoleProcessList`, 별도 프로세스를 띄워 목록을 받음). 앱이 먼저 끝나면 실행되지 않아 셸과 에이전트가 살아남는다 (조사 때 11월 22일의 로컬 셸이 부모 없이 남아 있었다).
  2. 다른 터미널(Orca 등)의 에이전트: 전역 등록이라 ezShell 과 무관하게 돈다.
  설치 프로그램이 MCP 를 끈 뒤 이들이 MCP 를 다시 띄우면 설치 폴더가 다시 잡힌다.
- 확인하지 못한 것: 실패한 그 순간에 어느 프로세스가 파일을 잡고 있었는지는 기록이 없다. 에이전트가 MCP 를 다시 띄우는지 직접 시험하려 했으나(MCP 프로세스 하나를 끄고 관찰) 권한 확인에서 막혀 하지 못했다.

## 수정
업데이트가 받아져 있으면(`updates.js` 의 `installsUpdateOnQuit`, 자동 설치와 `재시작` 둘 다) 앱이 끝나는 `will-quit` 에서:
- `agentMessages.pauseExternalBridge()`: 공유 연결 파일(`agent-message-connection`)을 한 줄로 바꾼다. Windows 실행기는 네 줄, POSIX 실행기는 두 줄을 읽어야 `ezShell.exe` 를 띄우므로, 업데이트하는 동안 어느 에이전트가 MCP 를 다시 띄워도 앱을 실행하지 않고 끝난다. 다음 시작이 파일을 다시 쓴다 (`main.js` 는 파일이 있으면 `enableExternalBridge`). 파일이 없으면 만들지 않는다 (파일이 있다는 것이 "메시지 MCP 를 설정한 사용자" 표시다).
- `localShells.closeAll({ killTrees: true })`: 살아 있는 셸마다 `taskkill /T /F /PID …` 를 한 번에 동기로 실행해 셸·에이전트·에이전트의 MCP 를 끝낸 뒤 터미널을 닫는다 (`localShell.js` 의 `killProcessTreesSync`). 업데이트 뒤 탭과 대화 다시 열기는 그 전에 기록되므로(`installUpdateKeepingTabs`) 그대로다.
- 이미 떠 있는 MCP(다른 터미널의 것)는 설치 프로그램이 끈다. 이 수정은 그 뒤에 다시 뜨는 것을 막는다.

이 코드는 새 버전이 "옛 버전"이 될 때부터 효과가 있다: 2.32.0 → 다음 버전 업데이트는 2.32.0 의 종료 처리로 돈다.

## 시험
- `localShell.test.js`: 업데이트 종료는 살아 있는 셸의 pid 만 한 번에 넘기고 터미널을 닫기 전에 부른다, 일반 종료는 부르지 않는다.
- `agentMessageMcp.test.js`: 일시 정지한 연결 파일은 한 줄이고 임시 파일이 남지 않으며, 다시 켜면 네 줄. 설정하지 않은 사용자에게 파일을 만들지 않는다.
- 실제 `taskkill /T /F` 로 시험용 트리(cmd → ping)를 끄면 자식이 모두 끝난다 (약 0.8초, 없는 PID 가 섞여도).
- 실제 업데이트 설치로는 시험하지 않았다 (설치본을 바꾸면 사용 중인 앱과 에이전트가 모두 끝난다). 다음 배포의 업데이트에서 확인한다.
