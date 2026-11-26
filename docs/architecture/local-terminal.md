# Local Terminal Tab (이 PC 의 셸)

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

탭 줄의 + 메뉴와 시작 화면의 `로컬 터미널` 로 이 PC 의 셸을 탭으로 연다. main 이 `node-pty` 로 실행하고(`src/localShell.js`, Windows 는 PowerShell), 탭은 `TerminalInfo.local`, id 는 `local:<번호>`, 화면은 `Terminal/LocalTerminalTab.tsx` 다 (`TerminalPanel` 을 쓰지 않는다). 설계: `docs/plan/2026-11-12-local-terminal-and-terminal-menu-additions.md`.
- 탭이 다시 그려져도(패인 분할, 탭 이동) 셸은 유지된다. main 이 셸마다 마지막 256KB 출력을 갖고 있다가 `local-shell-attach` 로 돌려준다. 화면은 attach 답을 받기 전에 온 출력을 버린다 (그 출력은 답에 이미 들어 있어서 두 번 그려진다).
- 창 자체를 다시 불러오면(개발 서버의 화면 새로 고침, 화면 비정상 종료 뒤) 탭은 모두 사라지지만 셸은 main 에 남는다. 탭으로 되살리기 전에도 실행 중인 에이전트는 메시지 MCP 의 `list_agents` 에 나온다. 첫 잠금 해제 뒤 로컬 탭이 하나도 없으면 `local-shell-list` 로 남은 셸을 받아 탭으로 되살리고, 끝난 셸은 닫는다 (`lib/localShellAdopt.ts`, 탭 제목은 폴더·에이전트에서). 분할한 탭은 칸 배치째 되살린다: 창이 사라질 때(`pagehide`) 탭마다 분할 트리와 칸별 셸 id 를 그 창의 `sessionStorage` 에 적고, 다시 불러온 창이 한 번 읽어 칸에 같은 셸을 붙인다 (`lib/localReloadLayout.ts`). 주 셸이 끝난 탭은 되살리지 않고 남은 셸을 각자 탭으로, 셸이 끝난 칸은 접는다. 채팅 보기였던 칸도 기록해 다시 채팅 보기로 연다. 개발 실행에서는 `preload.js` 가 바뀌면 창을 다시 불러온다. 화면 배치(화면 나누기)는 되살리지 않는다. 화면 테스트 `local-reload`, `local-reload-split`.
- 개발 서버(`electron.vite.config.ts` 의 `server.watch.ignored`)는 `mockups/`·`out/`·`release/`·`dist/`·`e2e/`·`docs/` 를 감시하지 않는다. 감시하는 곳의 `.html` 이 바뀌면 화면 전체를 다시 불러오는데, 다른 세션이 디자인 시안(`mockups/*.html`)을 고치거나 `npm run build` 로 `out/renderer/*.html` 을 다시 쓸 때마다 개발 앱의 탭이 사라졌다.
- 개수 제한은 없다 (예전 문서의 "10개까지" 는 코드에 없었다, 2026-11-24 확인). 탭을 닫으면 셸을 끝내고 앱을 종료하면 모두 끝낸다. SFTP, 로그 저장, 탭 복제, 창 분리, 일괄 명령, 연결 수에서는 뺀다 (분할은 된다: `Split Panes` 절) (`lib/sessionTabs.ts` 의 `isSshTab`, SSH 탭인지 볼 때는 `.db` 만 보지 말고 이 함수를 쓴다).
- Shift+Enter: 그 셸에서 Claude Code·Codex 가 돌 때(메시지 목록의 에이전트)만 `ESC`+`Enter`(`
`)를 보내 줄을 바꾼다 (`lib/agentNewline.ts`). xterm 은 Enter 와 Shift+Enter 를 같은 `
` 로 보낸다. 이 순서는 Claude Code 자체의 `/terminal-setup` 이 Shift+Enter 에 거는 값이고, Codex 0.170.0 도 줄바꿈으로 받는 것을 확인했다. 바꾸면 안 되는 것: 일반 PowerShell 에서는 보내지 않는다 (PSReadLine 에서 ESC 는 입력 중인 줄을 지운다). 화면 테스트 `local-agent-usage`.
- 분할하면 각 칸에 테마 모서리와 1px 카드 테두리가 생긴다 (`LocalTerminalTab.css`). 키보드를 받는 칸은 가장자리의 강조색 2px 선으로 표시한다. 칸 안쪽에 덧그리는 층이라 xterm 크기가 바뀌지 않는다. 상태를 따로 두지 않는다. 화면 시험 `local-split` 에서 구분선 끌기, 손잡이, 빈 자리, Alt 끌기 미리보기도 확인한다.
- 바꾸면 안 되는 것: `local-shell-*` IPC 는 본창에서 온 것만 받는다. MCP 도구나 휴대폰에서 로컬 셸을 직접 열거나 입력하는 경로를 만들지 않는다 (PC 에서 임의 명령을 실행하는 통로가 된다). 휴대폰의 에이전트 글 보내기는 [`Remote Access`](remote-access.md)의 설정과 `chatSend` 규칙을 지난다.
- 패키징: `node-pty` 는 사전 빌드(N-API)를 쓴다. `build.asarUnpack` 의 `node_modules/node-pty/**` 와 `npmRebuild: false` 를 지우지 말 것 (asar 안에서는 셸 실행 파일을 띄울 수 없고, 다시 빌드하려면 Visual Studio 빌드 도구가 필요하다). 새 `src/*.js` 라서 `MAIN_RUNTIME_MODULES` 에 있다.

## 개발 서버 기동 탭

- `src/ipc/localDevelopmentTasks.js`가 워크트리에서 기동 후보를 찾고, 사용자가 고른 ID로 실행 경로와 명령을 main에서 확정한다. 의존성 설치와 sparse checkout 포함은 기존 확인을 거친다. Gradle `bootRun`은 `--no-daemon`을 써서 이미 떠 있는 데몬이 PTY 밖에서 서버를 실행하지 않게 한다.
- `src/localShell.js`는 그 명령만 실행하는 전용 PTY를 연다. Windows는 PowerShell의 일회 실행으로 실제 명령 종료 코드를 전달한다. Unix는 로그인 셸에서 선택한 명령을 `exec`한다. 이 PTY의 실행과 종료 이벤트가 상태 기준이다. 의존성 설치도 같은 실행에 포함되며 포트 응답은 상태 판정에 쓰지 않는다.
- 재기동은 기존 트리를 종료하고 PTY 종료와 발견된 로컬 포트 해제를 확인한 뒤 같은 셸 ID에 새 PTY를 붙인다. 중지는 트리를 종료한다. Windows는 `taskkill /T /F`, Unix는 PTY 프로세스 그룹을 쓴다. 새 ConPTY의 첫 화면 지우기가 이전 출력을 덮기 전에 이전 화면을 스크롤백으로 보낸다. 종료 뒤에도 로그와 탭이 남고, 재기동은 이전에 확인한 실행 설정을 사용한다.
- 기동 탭의 재기동·중지 IPC는 잠금 해제된 본창의 주 프레임에서만, main에 있는 셸 ID와 그 셸의 기동 ID가 맞을 때 처리한다. 실행 구성은 본창에서 저장하며 main이 실제 실행 폴더와 실행 방법을 매번 확인한다. 직접 입력한 명령은 본창에서 그 명령을 확인한 뒤에 실행한다. 구성의 환경 변수와 JDK 경로는 해당 기동 PTY에 적용한다. 재기동은 같은 셸에 붙는다.
- 실행 구성은 프로젝트에서 공유하고 실행 상태와 오류는 워크트리별로 둔다. 카드는 해당 워크트리에서, 메시지 MCP의 `run_*`는 에이전트 셸의 워크트리에서 동작한다. 상태 목록과 이벤트에는 화면의 `pathKey`와 같은 워크트리 키가 들어간다.
- 실행 오류 진단은 워크트리별 최근 로그를 사용한다. 본창에서 승인한 Maven 미러는 다음 실행 확인을 거쳐 Spring Boot나 Tomcat의 Maven 명령에 `-gs` 설정으로 적용된다. 각 실행은 해당 Maven 버전의 설정 파일을 읽는다. 별도 승인한 사용자 설정 제외는 `-s`를 쓰며, 구성 삭제 시 앱의 전용 설정을 지운다.
- 바꾸면 안 되는 것. 에이전트 조작을 켜면 에이전트가 프로젝트의 빌드 스크립트를 샌드박스 밖에서 실행할 수 있다. 같은 프로젝트에 연결된 에이전트에게 저장된 구성 이름만 받는다. 본창에서 사용자가 명령을 확인하고, 실행할 때마다 main이 그 워크트리의 실제 폴더와 실행 후보를 검사한다. 기존 기동 탭의 셸 ID와 기동 ID를 받는 제어 경로는 본창 전용이다.
- 한계. 직접 명령 확인 해시는 앱의 확인 여부를 기억한다. 같은 OS 사용자로 `run-presets.json`을 수정할 수 있는 프로세스는 해시도 다시 쓸 수 있다.
- Spring Boot 실행 구성의 바로 반영은 실제 워크트리의 클래스 폴더와 `src/main/java`를 짝짓고, 변경된 소스를 실행에 쓰는 JDK로 컴파일한다. 표준·확장 모드는 해당 실행에만 루프백 JDWP를 열고 그 JVM의 클래스패스를 읽는다. DevTools 의존성이 있는 구성은 그 JVM에 `jcmd`로 클래스패스를 물어 컴파일만 한다. 재정의가 구조 변경을 거부하면 카드에서 재기동을 안내한다.
- 연결에서 바꾸면 안 되는 것. JDWP는 JVM이 실행되는 동안 연결을 유지하고 끊기면 즉시 재접속한다. 잠금 중에는 감시와 컴파일을 중단하고 재접속 핸드셰이크 외에 JVM 명령을 보내지 않는다. JVM이나 앱이 종료될 때 연결을 닫는다.
- Tomcat 실행 구성은 검증한 Ant 타깃이나 Maven 목표를 같은 PTY에서 먼저 실행할 수 있다. 기동 전 빌드가 실패하면 종료 코드와 로그를 남긴다. 성공하면 워크트리의 웹 폴더를 다시 검사하고 실행별 `CATALINA_BASE`를 만든다. HTTP는 이 PC의 `127.0.0.1`에서 접속할 수 있다. `server.xml`의 명시적 `Context`가 웹 앱을 띄운다. 설치 설정은 읽기 전용이다. 실행이 끝나면 폴더를 지우고, 비정상 종료로 남은 폴더는 같은 구성을 다시 실행할 때 정리한다. Java 바로 반영은 `WEB-INF/classes`, 웹 앱·Tomcat 라이브러리와 웹 앱의 Java 소스를 사용한다. JSP와 정적 파일 변경은 Tomcat이 읽는다.
- Tomcat의 이클립스식 빌드는 구성 폴더의 `.classpath`와 `.settings`를 읽고 지정된 인코딩·Java 버전으로 `javac`를 직접 실행한다. 클래스와 소스 리소스는 ezShell 사용자 데이터의 `runtimes/tomcat-classes`에 구성·워크트리별로 보관한다. 다음 기동에서는 바뀐 소스만 컴파일하고 삭제한 소스의 클래스와 리소스를 정리한다. Tomcat은 그 출력을 `/WEB-INF/classes`로 사용하며 바로 반영도 같은 폴더에 쓴다. 외부 JAR은 Tomcat 7의 가상 클래스패스 또는 Tomcat 8 이상의 `/WEB-INF/lib`에 연결한다.
- `src/ipc/developmentProcess.js`는 로그의 루프백 URL과 프레임워크 시작 포트를 주소 표시용으로 읽는다. 서버 주소를 읽지 못해도 상태·중지·재기동은 동작한다. 창만 다시 불러오면 main에 남은 기동 탭과 로그를 붙인다. 앱 프로세스가 다시 시작된 뒤 저장된 탭은 일반 셸로 복원한다.
