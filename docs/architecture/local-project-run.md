# 로컬 프로젝트 실행 구성

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

사이드바 **로컬 작업**의 실행 구성은 프로젝트의 서버 시작 방법을 저장한다. 구성은 프로젝트에서 공유하고, 실행 상태·오류·제안·터미널은 워크트리별로 둔다. 구성이 없는 워크트리는 카드에 자리를 두지 않고, 워크트리 줄에 마우스를 올리면 보이는 `+`(`RunPresetAddButton`)와 우클릭 메뉴의 `실행 구성 추가…`로 추가한다 (2026-11-26 사용자 요청). 그 메뉴는 처음부터 있는 항목(`실행 구성 추가…`, `파일 탐색기로 열기`)을 위에 두고, 조금 늦게 오는 기동 명령(`기동 명령 찾는 중…` 자리)을 그 아래에 붙인다: 위에 두면 명령이 도착하며 다른 항목을 포인터 아래에서 밀어냈다. 기동 명령을 고르면 바로 띄우지 않고, 그 폴더와 실행 방법을 고른 실행 구성 추가 창을 연다 (2026-11-26 사용자 요청, `presetSeedOfTask`). 메뉴의 id `backend:gradle` 은 창의 후보 id `.:gradle` 로 바꿔 넘긴다. 창의 버튼은 `추가만`·`추가하고 실행`이고 Enter 는 `추가하고 실행`이다. 같은 명령의 구성이 이미 있으면 창 없이 그 구성을 실행한다 (`presetOfTask`). 예외는 두 가지다. sparse checkout 에서 빠진 폴더의 명령(`includeSource`)은 구성으로 만들 파일이 아직 없어서 예전처럼 확인 뒤 바로 기동한다. 예전 방식으로 이미 띄운 셸이 그 워크트리에 있으면 그 탭으로 돌아간다. 구현 규칙은 이 문서를 기준으로 본다. 단계별 결정, 버전 검증 표본과 다운로드 공급자의 신뢰 기준은 [설계 기록](../plan/2026-11-25-local-project-run.md)에 있다.

## 구성과 실행 흐름

- main은 기본 체크아웃을 프로젝트 키로, 카드가 속한 실제 체크아웃을 워크트리 키로 잡는다. Git이 없는 프로젝트는 해당 로컬 폴더를 쓴다. 목록과 `run-preset-state` 이벤트의 워크트리 키는 렌더러의 `pathKey`와 같은 규칙을 따른다. `userData/run-presets.json`에 UUID·이름·워크트리 기준 폴더(`relative`)·실행 옵션을 저장하고, 읽을 때 다시 검증한다. 쓰기는 임시 파일을 만든 뒤 이름을 바꾸어 반영한다.
- `task`는 main이 찾은 Spring Boot의 Gradle `bootRun --no-daemon`·Maven `spring-boot:run`, 또는 패키지 매니저의 Node 개발 스크립트다. Gradle과 Maven은 프로젝트 래퍼를 우선한다. `--no-daemon`은 이미 떠 있는 Gradle 데몬이 PTY 밖에서 서버를 실행하는 일을 막는다. 일반 기동 후보에서 sparse checkout 포함이 필요한 경우, 의존성 설치가 필요한 경우에는 각각 해당 확인을 거친다. `custom`은 사용자가 입력한 한 줄 명령이다. 구성 창에서 `custom`을 고르면 명령 칸은 그 폴더에서 찾은 후보의 명령(고른 후보, 없으면 첫 후보)으로 채워진다. 사용자가 그 칸에 입력하기 전까지는 폴더를 바꿀 때마다 그 폴더의 후보 명령으로 바뀌고, 찾은 후보가 없으면 비워 둔다 (`suggestCustomCommand`). 저장된 명령은 그대로 둔다. `tomcat`은 웹 폴더와 Tomcat을 선택하고 Ant·Maven·이클립스식 준비 빌드를 선택할 수 있다.
- 찾은 Spring Boot 실행 구성에는 선택적으로 실행 포트(1~65535)와 한 줄 VM 인자를 저장할 수 있다. 입력한 포트는 해당 실행의 `SERVER_PORT` 환경 변수로 전달한다. VM 인자는 Gradle의 `bootRun` 앱 JVM 또는 Maven 플러그인의 `spring-boot.run.jvmArguments`에 전달한다. Maven POM에 `jvmArguments`를 직접 고정하면 그 설정이 우선한다. 두 값을 비워 두면 프로젝트가 정한 값을 사용하며, 포트나 인자를 바꾸면 실행 전에 다시 확인한다.
- 구성 창의 폴더는 직접 입력하거나 **찾아보기**로 고른다. 찾아보기는 main이 워크트리(입력된 폴더가 그 안에 있으면 그 폴더)에서 폴더 선택 창을 열고, 고른 폴더의 실제 경로를 저장 때와 같은 `directoryInProject`로 확인해 상대 경로로 돌려준다 (`run-preset-choose-folder`). 바깥을 가리키는 연결 폴더와 `.git`은 거부한다.
- `runPresets.js`의 `freshTask`가 실제 실행 폴더와 후보를 다시 확정한다. `src/localShell.js`는 준비와 서버의 출력을 같은 실행 로그에 모은다. Ant·Maven 준비는 빌드 PTY에서 실행하고, 이클립스식 준비는 main이 `javac`를 실행한다. 준비 성공 뒤에만 서버를 시작한다. Windows는 PowerShell 일회 실행의 실제 종료 코드를 전달하고, Unix는 로그인 셸에서 후보 명령을 `exec`한다.
- 사이드바 실행 구성의 첫 줄에는 이름과 실행 버튼을 둔다. 폴더 경로, Git 배지, 기동 단계와 실행 상태는 아래에 표시한다. 긴 이름은 줄임표와 행의 툴팁으로 표시한다. 오류 수는 경고 아이콘과 숫자로 보이고, 실행 중 주소가 있으면 아래 줄의 포트를 눌러 브라우저를 연다 (`lib/runPresets.ts` `runButtons`, 화면 시험 `local-development-tasks`).
- 실행 구성 머리의 `기동 순서…`에서 프로젝트의 단계를 편집한다. 같은 단계의 구성은 동시에 시작하고, 새 단계나 모두 실행에서 제외한 곳으로 구성을 옮길 수 있다. 순서가 없는 기존 형식은 `inAll` 구성만 목록 순서대로 한 단계씩 두고, 다음 구성의 `waitReady`를 앞 단계의 기다림 기준으로 쓴다. 새 구성은 맨 끝 단계에 넣고, 삭제·제외한 구성은 순서에서 뺀다.
- 시작하기 전에 실행 내용과 필요한 설치를 확인한다. 단계 기준은 기존 시작 완료 표시, 실행 중인 구성의 서버 로그에 지정 문구가 나옴, 지정한 헬스 URL이 HTTP 2xx를 반환함, 기다리지 않음 중 하나다. 헬스 확인은 `http://127.0.0.1`·`http://localhost`·`http://[::1]`에만 접속하고 리디렉션을 따라가지 않는다. 다음 단계로 갈 때까지 워크트리별로 진행과 기다림 시간을 표시한다. 정상 종료와 수동 중지는 다음 단계를 막지 않는다. 시간 초과나 비정상 종료로 멈추면 로그를 보고, 조건을 다시 확인하거나, 건너뛰어 다음 실행을 이어갈 수 있다. `취소`를 누르면 이미 띄운 서비스는 유지하고 기동 순서만 닫는다.
- 기본 대기 시간은 5분이다. 시간을 넘겨도 계속 진행할지, 모두 중지할 때 뒤 단계부터 중지할지, 한 구성만 실행할 때 꺼진 앞 단계도 띄울지 물을지를 순서 화면에서 정한다. 일괄 시작이나 중지가 진행 중이면 프로젝트의 순서를 저장할 수 없다. `모두 중지`는 해당 워크트리의 일괄 시작을 취소한다. 앱이 잠겨 일괄 시작이 취소되면 잠금 해제 뒤 상태를 보여 준다. `notify`와 `agentControl`은 구성별 스위치다.
- 실행 묶음은 머리의 `모두 실행` 자리에서 고른다(▾: 묶음 목록·`전체`·`묶음 만들기…`). main은 묶음에 든 구성만 프로젝트의 기동 단계대로 띄운다(`selectStartStages`). 기동 순서에 없는 묶음 구성은 구성 목록 순서대로 한 단계씩 뒤에 붙이고, 역순 중지는 그 단계부터 멈춘다. 묶음은 `userData/run-bundles.json`에 프로젝트 키별로 저장한다(`runBundleStore.js`). 읽을 때 삭제된 구성 ID를 빼고, 비면 그 묶음을 버린다. 마지막으로 고른 묶음은 이 PC의 `localStorage`에만 기억한다.
- 실행·재기동은 백그라운드에서 진행한다. 카드의 **로그 보기**로 실행 중이거나 종료된 서비스의 로그를 탭에서 열 수 있다. 로그 탭을 닫아도 실행과 최근 출력은 main에 남는다. 화면을 다시 불러오면 열어 둔 로그 탭만 복원한다. [로컬 PTY의 수명과 복원](local-terminal.md)
- 중지는 개발 프로세스 트리를 끝낸다. Windows는 `taskkill /T /F`, Unix는 PTY 프로세스 그룹을 쓴다. 재기동은 종료와 발견된 로컬 포트의 해제를 확인한 뒤 같은 셸 ID에 새 PTY를 붙인다. ConPTY가 새 화면을 지우기 전에 이전 출력을 스크롤백으로 보낸다.
- 개발 서버 탭(실행 구성과 찾은 기동 명령으로 띄운 셸)의 로그에 스크롤백이 생기면 오른쪽 아래에 `맨 위로`·`맨 아래로` 버튼이 나온다 (`Terminal/TerminalScrollJump.tsx`, 위치 판단은 `lib/terminalScrollJump.ts`). 최신 줄을 따라가는 동안에는 흐리게, 위로 올려 본 동안에는 `맨 아래로`를 강조색으로 보인다. 버튼은 터미널의 포커스를 가져가지 않는다. 채팅 보기와 전체 화면 프로그램(대체 화면)에서는 숨긴다. 화면 시험 `local-development-tasks`.

**바꾸면 안 되는 것**

- 저장·제어 IPC는 잠금 해제된 본창의 주 프레임에서 받고, 기동 탭 제어는 셸 ID와 기동 ID가 모두 맞는지 확인한다. main에서 워크트리 안의 실제 경로와 현재 실행 후보를 확인한 뒤 실행한다. 구성의 `jdk`와 `env`는 해당 실행 PTY에만 적용한다. 일반 기동 탭의 제어 경로와 에이전트용 구성 이름 경로의 권한을 각각 유지한다.
- `presetApproval`은 직접 입력한 명령이나 자동 후보 ID와 함께 `relative`·`jdk`·`env`·`hotReload`를 해시에 반영한다. Tomcat의 설치 ID·웹 폴더·컨텍스트 경로·포트·준비 빌드·VM 인자·컨텍스트 설정 파일(`contextXml`) 경로·추가 JAR과 Maven 실행 옵션 및 승인된 온라인 설정도 반영한다. `logEncoding`은 출력의 인코딩과 해석에 쓰이므로 실행 대상의 확인 해시에서 제외한다. 확인 창에는 환경 변수 이름을 보여 주고 값은 해시에만 반영한다. 기존 해시는 새 형식으로 한 번 다시 확인받는다. 같은 OS 사용자로 설정 파일에 쓸 수 있는 프로세스는 해시도 바꿀 수 있다.

- 앱이 시작하면 소유 PID가 종료된 javac, 이클립스 빌드, Maven, Tomcat 실행 임시 폴더를 앱 소유 경로에서 회수한다. 정리 대상은 검증된 실제 경로와 소유 PID가 들어 있는 실행 폴더 이름으로 제한한다. 앱 종료 시 개발 프로세스를 중지하고 진행 중인 정리를 최대 5초 기다린다. 업데이트 재시작(Windows)에서는 실행 중인 서버를 끄지 않고 다음 앱에 넘긴다 ([앱 업데이트와 탭 복원](app-updates.md)). 넘겨받은 서버가 쓰는 옛 앱 PID 의 임시 폴더는 그 서버가 끝날 때까지 회수하지 않는다 (`runScratch.js` 의 `protectScratchOwner`, Tomcat base 의 실행 전 정리도 같은 검사를 쓴다). 잠겨 있는 임시 폴더는 다음 시작에서 다시 검사한다. [실행 임시 폴더](../../src/ipc/runScratch.js)

**파일 지도** — 프로젝트와 후보는 [localProjects.js](../../src/ipc/localProjects.js)·[localDevelopmentTasks.js](../../src/ipc/localDevelopmentTasks.js), 저장·실행·PTY는 [runPresetStore.js](../../src/ipc/runPresetStore.js)·[runPresets.js](../../src/ipc/runPresets.js)·[localShell.js](../../src/localShell.js), 화면은 [RunPresetDialog.tsx](../../src/renderer/components/Sidebar/RunPresetDialog.tsx)·[RunPresetsSection.tsx](../../src/renderer/components/Sidebar/RunPresetsSection.tsx)·[runPresetStore.ts](../../src/renderer/stores/runPresetStore.ts)에서 본다.

## JDK와 개발 도구 보관함

설정의 **개발 도구**에서 Temurin·Zulu JDK, 확장 바로 반영용 JBR 17·21과 HotswapAgent, Tomcat·Maven·Ant·Gradle·Node를 관리한다. 관리 JDK는 `userData/runtimes/jdk/`와 `runtimes.json`에서 찾는다. PC에 설치된 JDK는 `JAVA_HOME`과 플랫폼별 등록 후보를 살피고 `release` 및 `bin` 실행 파일을 확인한다. Gradle·Node와 Apache 도구도 이미 설치된 도구를 찾는다. Tomcat 6은 사용자가 설치 폴더를 등록한다. 구성은 경로 대신 JDK·도구 ID를 저장한다. `system`은 해당 PTY의 `JAVA_HOME`·`PATH`를 사용하고, 선택한 JDK가 있으면 main이 ID를 확인해 그 PTY의 `JAVA_HOME`과 `PATH` 앞에 적용한다. 폴더에서 추정한 Java 버전은 구성 화면의 선택을 돕는다.

**바꾸면 안 되는 것**

- 다운로드와 리디렉션은 각 공급자의 HTTPS 호스트 허용 목록을 따른다. 공급자가 제공한 체크섬이 맞는지 확인하고 압축 경로를 검사한 뒤 임시 폴더에 푼다. 배치가 끝난 설치본만 이름 바꾸기로 게시한다. 내려받기·삭제는 본창 주 프레임과 잠금 해제를 검사한다. JDK 선택으로 OS 전역 환경, 레지스트리, 사용자 셸 설정을 수정하는 경로를 만들지 않는다.

**파일 지도** — 목록·설치·삭제는 [runtimes/index.js](../../src/runtimes/index.js)·[runtimes/ipc.js](../../src/runtimes/ipc.js), PC 검색과 버전 추정은 [discovery.js](../../src/runtimes/discovery.js)·[required.js](../../src/runtimes/required.js), 다운로드·압축은 [download.js](../../src/runtimes/download.js)·[archive.js](../../src/runtimes/archive.js)와 같은 폴더의 공급자 모듈, 화면은 [JdkSettings.tsx](../../src/renderer/components/Settings/JdkSettings.tsx)·[ApacheToolSettings.tsx](../../src/renderer/components/Settings/ApacheToolSettings.tsx)에서 본다.

## 로그, 오류 판정, 진단과 제안

- PTY가 실행·종료의 기준이다. 준비 중에는 로그 주소를 서버의 시작 완료로 세지 않는다. 서버 단계에서는 프레임워크의 시작 문구와 로그의 루프백 주소로 `readyAt`과 표시 주소를 정한다. 주소를 읽지 못해도 중지와 재기동은 동작한다. 포트 확인은 재기동 전 해제 확인에 쓴다. 사용자 중지와 별개로 실패하거나 0이 아닌 코드로 끝나면 `crashed`, 정상 종료는 `stopped`다. 준비 빌드 실패에는 `failedAt: 'prepare'`가 붙는다.
- 알려진 기동·빌드 오류와 일반 로그 수준 규칙으로 스택 줄을 오류 묶음에 붙인다. 최근 로그 400줄, 오류 20묶음과 묶음당 최대 80줄은 실행의 메모리에 둔다. 새 실행에서 비운다. Windows 시스템 알림에는 프로젝트·구성 이름만 넣고, 오류 내용은 본창에서 본다. `에이전트에게 보내기`는 main에서 구성 이름·상대 폴더·실행 방식·종료 코드·마지막 오류와 사용자 메모를 합쳐 미리 보여 준다. main은 프레임·프로젝트·워크트리·구성에 묶인 본문 해시 토큰을 발급하고, 같은 토큰의 본문을 `user`로 한 번만 보낸다.
- 진단은 현재 워크트리의 최신 실행 로그에서 누락 클래스·JDK 버전·JNDI·인코딩·포트·Maven 의존성과 저장소 문제를 찾는다. 누락 클래스의 JAR 후보는 프로젝트, `~/.m2/repository`, Gradle 모듈 캐시에서 찾는다. Tomcat에 붙일 JAR은 실제 파일과 허용된 위치를 승인 직전에 다시 확인한다. 제안은 실행별로 메모리에 두며, 최신 진단과 맞을 때 본창에서 적용하거나 버린다. 저장 값이 바뀌는 제안은 적용 뒤 다음 실행에서 바뀐 내용을 확인받는다.

**바꾸면 안 되는 것**

- 예상치 못한 종료에는 실행 구성 줄과 실패 알림에 원인 한 줄을 표시한다. 기존 실행 진단에서 인식한 원인이나 최근의 구체적인 오류 내용을 사용한다. 근거가 없으면 확인된 종료 코드만 안내한다. 원인은 본창에 전달하기 전에 자격 증명을 가리고 다음 실행에서 지운다.
- 터미널의 색·제어 문자열을 진단과 MCP 반환값에서 정리한다. MCP 실행 도구의 응답, 화면 오류 묶음과 진단, 에이전트에게 전달할 본문, 제안 메모에 들어 있는 자격 증명 패턴을 `****`로 가린다. 제안 메모는 가린 값으로 보관하고 터미널은 원래 출력을 표시한다. 제안은 원래 실행과 최신 진단 ID에 묶는다. 실행이나 관련 구성이 바뀌면 다시 검증하며, 에이전트의 제안 등록은 사용자 승인 전까지 구성이나 실행을 바꾸지 않는다. 사용자 승인으로 넣는 미러·JAR은 일반 구성 저장 요청의 임의 필드로 추가할 수 없다.

**파일 지도** — 주소·오류·진단은 [developmentProcess.js](../../src/ipc/developmentProcess.js)·[developmentErrors.js](../../src/ipc/developmentErrors.js)·[runDiagnosis.js](../../src/ipc/runDiagnosis.js), 진단 적용·제안은 [runSuggestions.js](../../src/ipc/runSuggestions.js)·[runJarSuggestions.js](../../src/ipc/runJarSuggestions.js)·[runProposals.js](../../src/ipc/runProposals.js), 화면은 [RunSuggestions.tsx](../../src/renderer/components/Sidebar/RunSuggestions.tsx)·[RunPresetsSection.tsx](../../src/renderer/components/Sidebar/RunPresetsSection.tsx)에서 본다. [공통 로그 수준 규칙](terminal-logs.md)

## 바로 반영

- `hotReload`는 `off`·`standard`·`enhanced`이고 옛 구성에서 값이 없으면 `off`다. Spring Boot 후보와 Tomcat에서 사용할 수 있다. 표준은 실행에 붙은 JDWP로 이미 로드된 Java 클래스를 재정의한다. 필드·메서드 추가와 같은 변경을 JVM이 거부하면 카드에 재기동 필요를 표시한다. 바꾸면 안 되는 것: 거부되거나 컴파일되지 않았거나 반영 여부를 확인하지 못한 소스는 다음 저장 때 새 변경과 한 요청으로 다시 보낸다 (`hotReload.js`의 `carried`). 따로 보내면 메서드를 새로 부르는 클래스만 반영되어 `NoSuchMethodError`가 난다 (`docs/fix/2026-11-27-hot-reload-partial-apply.md`). 확장은 보관함의 JBR 17·21과 검증된 HotswapAgent로 더 많은 구조 변경을 처리한다. 클래스 구조에 따라 재기동이 필요할 수 있다. 바꾸면 안 되는 것: 확장 인자의 `--add-opens=java.base/sun.nio.ch`·`java.base/java.io` 는 빼지 않는다. HotswapAgent 의 MyBatis 플러그인이 매퍼 XML 을 읽을 때 JDK 내부 필드에 접근하고, 열려 있지 않으면 앱이 `sqlSessionFactory` 오류로 뜨지 않는다 (`docs/fix/2026-11-27-enhanced-reload-mybatis-add-opens.md`).
- Spring Boot는 실행 중인 JVM의 클래스패스를 읽고 해당 워크트리의 출력 폴더와 `src/main/java`를 짝짓는다. 기존 DevTools 의존성이 있으면 `jcmd`로 그 JVM의 클래스패스를 확인하고 바뀐 Java 소스를 컴파일한다. 다시 로드하는 일은 DevTools가 처리한다. Tomcat은 웹 앱의 클래스 출력과 웹 앱·Tomcat 라이브러리, 웹 앱의 Java 소스를 사용한다. JSP·정적 파일은 Tomcat이 읽는다.
- 소스 변경을 짧게 묶어 구성 JDK의 `javac`로 컴파일하고, 기존 클래스의 Java 버전과 빌드의 소스 인코딩을 따른다. Maven은 Spring Boot 플러그인의 JVM 인자 속성, Gradle은 앱 데이터의 `bootRun` 초기화 스크립트, Tomcat은 `CATALINA_OPTS`를 쓴다. 바로 반영 이벤트와 컴파일 오류가 카드와 `run_*` 결과로 간다.

**바꾸면 안 되는 것**

- JDWP는 실행마다 고른 `127.0.0.1`의 포트에서 `quiet=y`로 연다. 접속할 때마다 Windows `netstat`, macOS `lsof`, Linux `/proc`로 리스너가 실행 프로세스 트리 소유인지 확인한다. 확인할 수 없는 동안에는 접속을 보류한다. OS 조회와 TCP 접속 사이에는 짧은 시차가 있다. JDWP 포트는 터미널·오류·주소·MCP 결과에서 가린다. JVM이 실행되는 동안 연결을 유지하고, 끊기면 바로 다시 연결한다. 잠금 중에는 감시와 컴파일을 중지하고 재접속 핸드셰이크 외의 JVM 명령을 보내지 않는다. JVM이나 앱이 종료되면 연결을 닫는다. JDWP를 쓰는 실행과 IDE 디버거는 연결을 공유할 수 없다.
- JVM이 알려 준 경로를 실제 경로로 확인하고, 이 기능에 허용된 클래스 출력에만 쓴다. 디버그 JVM 인자는 앱에만 적용한다. Maven 실행 JDK를 바꾼 Spring Boot의 확장 바로 반영은 구성과 같은 JBR이 필요하다.

**파일 지도** — 실행 인자·연결 수명·감시는 [hotReload.js](../../src/ipc/hotReload.js), 클래스패스·컴파일은 [hotReloadJava.js](../../src/ipc/hotReloadJava.js), 프로토콜·클래스 파일은 [jdwp.js](../../src/runtimes/jdwp.js)·[classFile.js](../../src/runtimes/classFile.js), 확장 보관함은 [enhancedProviders.js](../../src/runtimes/enhancedProviders.js)에서 본다.

## Tomcat, 이클립스와 워크스페이스

- 준비가 끝나면 main이 워크트리의 웹 폴더를 다시 검사하고 실행별 `CATALINA_BASE`를 만든다. 원본 설치 `conf`는 읽고, HTTP `127.0.0.1`과 명시적 `Context`를 임시 `server.xml`에 설정한다. 원본 설치 폴더는 `CATALINA_HOME`으로 사용한다. 실행 종료 때 base를 정리하고, 같은 구성을 다시 실행할 때 이전에 비정상 종료한 프로세스의 base도 정리한다.
- 이클립스 가져오기는 프로젝트 안의 `.classpath`·`.settings`에서 소스·라이브러리·웹 폴더·컨텍스트·Java 버전·인코딩을 읽어 구성 창의 초안을 채운다. 사용자가 저장하면 적용된다. 이클립스식 빌드는 지정된 Java 버전과 인코딩으로 `javac`를 실행한다. 소스 인코딩 설정이 없으면 MS949를 사용한다. `userData/runtimes/tomcat-classes/`의 구성·워크트리별 출력에 클래스와 리소스를 둔다. 다음 빌드는 바뀐 소스를 다시 컴파일하고 지운 소스의 클래스와 리소스를 정리한다. 그 출력은 Tomcat의 `/WEB-INF/classes`와 바로 반영에서도 쓴다.
- 워크스페이스 가져오기는 잠금 해제된 본창에서 사용자가 고른 Eclipse 폴더의 서버 설정과 `.launch`를 읽는다. 프로젝트별 폴더 승인은 `run-workspace-folders.json`에 둔다. 자체 관리하는 Tomcat 경로와 자격 증명으로 보이는 VM 인자는 가져오지 않는다. 컨텍스트 참조는 현재 워크트리 또는 이 프로젝트에 승인된 워크스페이스의 실제 파일이어야 한다. main은 실행 직전에 경로를 다시 검사하고 `Resource`·`Environment`·`Parameter`를 그 실행의 컨텍스트에 쓴다. JDBC 드라이버가 없으면 오류 묶음에 남긴다. 승인한 외부 JAR은 Tomcat 7의 가상 클래스패스 또는 8 이상의 `/WEB-INF/lib`에 연결한다.
- **IntelliJ·VS Code 설정**은 선택한 실행 폴더와 워크트리 루트에서 읽는다. IntelliJ의 로컬 Tomcat과 Smart Tomcat(`.run/*.run.xml`, `.idea/runConfigurations/*.xml`, `.idea/workspace.xml`), VS Code의 Java Tomcat Bootstrap 실행과 Community Server Connectors의 서버 JSON을 지원한다. **설정 파일 선택…**으로 별도 위치의 설정 파일도 직접 고를 수 있다. 읽을 수 있는 포트·컨텍스트 경로·웹 폴더·VM 인자·`META-INF/context.xml` 참조를 구성 초안으로 가져온다. 여러 실행 설정이면 사용자가 하나를 고른다. 웹 폴더와 추가 XML은 검증한 워크트리 안에서만 찾고, 지원하는 VM 인자만 가져온다. Tomcat·JDK와 기동 전 빌드는 ezShell 실행 구성에서 선택한다. [설정 읽기](../../src/ipc/tomcatIdeImport.js)
- `logEncoding`은 `auto`·`utf-8`·`ms949`다. Unix PTY의 자동 모드는 UTF-8 오류가 이어지면 MS949로 전환한다. Windows ConPTY는 전용 콘솔 코드 페이지에서 이미 해석한 문자열을 보낸다. 선택 모드는 Java 표준 출력·오류와 Tomcat의 복사된 로그 설정에도 적용한다. 화면·오류 판정·MCP는 같은 디코딩 결과를 사용한다.

**바꾸면 안 되는 것**

- 원본 Tomcat 설정, 이클립스 설정, 컨텍스트 XML은 읽기 전용으로 다룬다. ezShell이 만드는 base와 이클립스식 빌드 출력은 사용자 데이터에 둔다. `run-presets.json`에는 XML 경로만 저장한다. DB 비밀번호 등 컨텍스트 값은 필요한 실행의 임시 base에만 쓰고 로그·제안·구성에 복사하지 않는다. 승인된 실제 경로의 파일과 열린 XML 핸들의 파일 ID가 같은지 확인하고 읽기 상한을 지킨다.

**파일 지도** — 기동과 가상 웹 리소스는 [tomcatRun.js](../../src/ipc/tomcatRun.js), 이클립스는 [eclipseProject.js](../../src/ipc/eclipseProject.js)·[eclipseBuild.js](../../src/ipc/eclipseBuild.js), 워크스페이스·컨텍스트는 [workspaceServers.js](../../src/ipc/workspaceServers.js), 인코딩은 [developmentEncoding.js](../../src/ipc/developmentEncoding.js), 구성 화면은 [RunPresetTomcatFields.tsx](../../src/renderer/components/Sidebar/RunPresetTomcatFields.tsx)에서 본다.

## Maven 미러, JDK 분리와 보관본

- 온라인 미러 항목은 진단에 나온 저장소 ID 하나와 승인한 HTTPS 또는 로컬 `file:` 주소를 연결한다. 실행마다 버전에 맞는 전용 설정을 만들고 기본 `-gs`로 넘긴다. Maven 3.8.1 이상이거나 버전을 모르는 경우 기본 HTTP 차단도 포함한다. 사용자 미러가 우선하는 경우 사용자가 별도로 승인하면 `-s`로 사용자 설정을 대체한다. 이때 사용자 인증·프록시·미러·로컬 저장소 설정도 함께 제외된다. 원본 `settings.xml`과 POM은 읽기 전용으로 다룬다.
- `mavenRunner`는 Maven 실행에 사용할 보관함 JDK 17·21의 ID다. JDK가 17 미만인 Tomcat 준비는 자동으로 17→21→구성 JDK 순으로 선택한다. Spring Boot는 기본으로 구성 JDK를 사용하고, 사용자가 `mavenSplit`을 켜면 구형 JDK에서 같은 자동 선택을 사용한다. 명시한 Maven 실행 JDK는 두 실행 방식에 적용된다. 분리할 때 Compiler의 `fork`·`executable`과 Surefire의 `jvm`으로 컴파일과 포크된 테스트에 프로젝트 JDK를 넘긴다. Tomcat 앱은 구성 JDK를 쓰고, Spring Boot 앱이 Maven JDK로 뜰 수 있다는 점은 설정·실행 로그·TLS 진단에서 안내한다. POM에서 고정한 플러그인 옵션과 `MAVEN_OPTS`의 제거된 JVM 옵션은 분리를 제한할 수 있다.
- `mavenPin`을 켠 온라인 실행은 실행별 빈 로컬 저장소에서 Maven을 실행하고, 정상 종료 코드 0일 때 Resolver가 원격에서 받았다고 기록한 정식 아티팩트·플러그인과 필요한 메타데이터를 보관한다. 기본 위치는 `userData/runtimes/maven-pinned/<구성 id>/`이며, 게시 한도는 1 GiB와 12,000개 파일이다. 실패·중단·빈 결과·상한 초과 시 이전 보관본을 유지하며, SNAPSHOT과 로컬 `install` 결과는 보관 대상에서 제외한다. 401·404·DNS 진단에서 사용할 수 있는 보관본을 제안한다.
- `mavenSource: 'pinned'`는 새 로컬 저장소와 보관본의 복사본을 가리키는 `file:` 미러를 사용한다. `-s`는 `mirrorOf=*`인 파일 미러, `-gs`는 빈 전역 설정이다. Maven은 `file:` 미러도 저장소로 취급하므로 파일 전송기를 사용할 수 있게 `-o` 없이 실행한다. 재현에는 보관 때 사용한 Maven 버전과 호환되는 플러그인이 필요하다.

**바꾸면 안 되는 것**

- 보관본 실행에는 온라인 진단 미러 인수를 섞지 않는다. Windows에서 `-D이름=경로`와 공백이 든 경로를 각각 원래 인수 하나로 보존한다. 앱이 만드는 설정·보관·실행 임시 폴더는 사용자 데이터에 둔다. 워크트리의 `.mvn-repo/`는 본창에서 확인한 워크트리의 폴더 ID가 일치할 때 새로 만들고 기존 폴더에는 덮어쓰지 않는다. 복사 전후와 실패 정리 전에 대상 폴더를 다시 확인한다. 구성 삭제는 전용 미러 설정과 실행 임시 폴더를 정리하고, 보관본 삭제는 별도 사용자 확인을 거친다.

### 같은 OS 사용자가 파일을 바꾸는 경우

ezShell은 파싱 전에 열린 XML 파일의 동일성을 확인하고 Maven 내보내기 때 대상 폴더를 다시 확인한다. 파일 검사와 경로를 사용하는 작업 사이에는 시간차가 있다. 해당 폴더에 쓰기 권한이 있는 같은 OS 사용자의 다른 프로세스는 그 사이에 경로나 폴더 내용을 바꿀 수 있다. 이런 동시 변경은 로컬 파일 경로 검사의 한계다.

**파일 지도** — Maven 실행 연결은 [runMaven.js](../../src/ipc/runMaven.js)·[runPresets.js](../../src/ipc/runPresets.js), 설정·JDK·보관은 [mavenSettings.js](../../src/runtimes/mavenSettings.js)·[mavenJdk.js](../../src/runtimes/mavenJdk.js)·[mavenPin.js](../../src/runtimes/mavenPin.js), 내보내기·삭제·상태 IPC는 [preload.js](../../src/preload.js)와 `registerRunPresetIpc`에서 본다.

## 에이전트의 `run_*` 도구

메시지 MCP는 활성 에이전트의 인증된 로컬 셸을 확인한다. Linux와 macOS에서는 OS에서 조회한 셸의 현재 폴더를 쓴다. Windows에서는 앱이 검증해 ConPTY에 넘긴 시작 폴더에 권한을 고정하고, 다른 워크트리는 해당 폴더에서 새 로컬 셸을 열어 이용한다. 터미널 출력에서 읽은 폴더는 표시용이다. 분할·탭 이동은 셸 ID로 같은 권한을 유지하며, 교체·복원은 시작 폴더에서 다시 연다. 잠든 에이전트나 셸에 묶이지 않은 에이전트는 거부한다.

| 도구 | 동작 |
| --- | --- |
| `run_list` | 구성 이름·상태·포트·오류 수·에이전트 조작 허용 여부와 바로 반영 상태를 읽는다. 일괄 기동 중이면 `startup`에 현재 단계와 멈춤 이유를 제공한다. |
| `run_start` · `run_restart` · `run_stop` | 저장된 구성 이름으로 실행·재기동·중지한다. |
| `run_start_all` · `run_stop_all` | 기동 순서대로 모두 실행·중지한다. `bundle`(묶음 이름, `run_list` 의 `bundles`)을 주면 그 묶음의 구성만 다룬다. |
| `run_wait` | `until: 'ready'` 또는 `'reload'`를 기다린다. 제한 시간은 1~300초다. |
| `run_log` | 최근 로그 최대 400줄, 또는 `errors: true`로 오류 묶음·진단·자기 제안 상태를 읽는다. |
| `run_propose` | `run_log`의 최신 제안 ID로 미러 변경·사용자 설정 제외·JAR 추가 중 하나를 본창에 제시한다. 실행마다 최근 제안 최대 5개를 둔다. |

**바꾸면 안 되는 것**

- 잠금 중에는 모든 `run_*`를 거부한다. `agentControl`은 시작·재기동·중지에 적용한다. 조회·대기·제안에는 적용하지 않는다. 사용자가 현재 워크트리에서 직접 중지한 뒤 30초 동안은 에이전트의 시작·재기동을 막는다. 에이전트가 처음 구성을 시작하거나 재기동하면 누가 조작했는지 안내하고, 안내 여부는 프로젝트 구성에 저장한다.
- 묶음 저장·삭제는 본창 IPC(`run-preset-bundle-save`·`-delete`)만 받고 main 이 다시 검사한다(`runBundles.js`): 이름 1~20자 한 줄·제어 문자 없음·프로젝트에 같은 이름 없음, 프로젝트에 없는 구성 ID 거부, 묶음 20개까지. 모두 실행의 확인 질문은 묶음 ID 별로 따로 기억해 한 묶음에서 받은 답을 다른 묶음에 쓰지 않는다.
- 도구는 저장된 이름을 사용한다. 임의 명령·폴더·셸 ID 입력, 구성 저장, 사용자 실행 확인은 본창 권한으로 남겨 둔다. 에이전트 시작으로 실행되는 빌드 스크립트는 에이전트 샌드박스 밖인 ezShell 로컬 PTY에서 사용자 권한을 갖는다. 제안의 JAR 후보는 프로젝트 상대 경로나 좌표만 MCP로 돌려준다. 최신 진단의 ID와 사용자 적용 경계는 본창 진단과 같다.

**파일 지도** — 도구 등록·인증 전달은 [agentMessageMcp.js](../../src/ipc/agentMessageMcp.js)·[agentMessages.js](../../src/ipc/agentMessages.js), 워크트리·권한·실행은 [runPresets.js](../../src/ipc/runPresets.js)의 `agentProject`·`agentTool`에서 본다. [메시지 MCP와 셸 연결](mcp-and-agent-messages.md)

## 확인할 시험

- 기동 순서의 변환·검증·동시 실행·대기 기준은 [runStartOrder.test.js](../../src/ipc/runStartOrder.test.js)에서 확인한다. 순서 편집과 일괄 실행·실패 복구 화면은 `npm run e2e -- local-start-order`로 확인한다.
- 실행 묶음은 [runBundles.test.js](../../src/ipc/runBundles.test.js)·[runBundleStore.test.js](../../src/ipc/runBundleStore.test.js)·[runPresetBundles.test.js](../../src/ipc/runPresetBundles.test.js)(IPC·에이전트 도구)와 [lib/runBundles.test.ts](../../src/renderer/lib/runBundles.test.ts)에서 확인한다.
- 구성·권한·진단은 [runPresets.test.js](../../src/ipc/runPresets.test.js)와 같은 폴더의 `runDiagnosis`·`runSuggestions`·`developmentErrors` 테스트에서 확인한다. 준비·재기동 PTY 수명은 [localShell.test.js](../../src/localShell.test.js), 바로 반영과 Tomcat은 [hotReload.test.js](../../src/ipc/hotReload.test.js)·[tomcatRun.test.js](../../src/ipc/tomcatRun.test.js)를 본다.
- 화면은 바꾼 기능의 명세만 실행한다. 구성과 Maven 실행은 `npm run e2e -- local-development-tasks`, 에이전트 제안은 `npm run e2e -- local-run-proposals`, 도구 보관함은 `npm run e2e -- jdk-runtimes`다. [시험 범위](../../CLAUDE.md#build--run)
