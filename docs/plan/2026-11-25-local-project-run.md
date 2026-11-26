# 로컬 프로젝트 실행 구성 (기동·재기동·오류 알림·에이전트 조작·JDK·레거시·바로 반영)

작성: 2026-11-25 (사용자 요청: "백엔드 프론트엔드 폴더를 잡아두고 버튼으로 실행하고 재기동하고 오류나면 알려주는 기능", 이어서 에이전트 조작, 레거시(Ant·Tomcat·Maven), JDK 받기, JRebel 같은 바로 반영)

시안: `mockups/dev-run-presets.html` (장면 1~8, 사용자가 좋다고 함)

상태: 1단계 끝 (2026-11-26, 리뷰 3회 반영). 3단계 표준·확장 끝 (2026-11-26, 사용자 확인 전). 2단계 진행 중 (도구 받기부터).

## 지금 있는 것 (2.36.2, 바탕으로 쓴다)
- `src/ipc/localDevelopmentTasks.js`:
  - 워크트리에서 기동 후보를 찾는다: Spring Boot(Gradle `bootRun --no-daemon`, Maven `spring-boot:run`), `package.json` 의 `dev`/`serve`.
  - 창은 후보 id 만 보내고, main 이 명령과 폴더를 다시 확정한다.
- `src/localShell.js`:
  - 그 명령만 도는 전용 PTY 를 띄운다. 상태와 종료 코드는 프로세스로 안다.
  - 재기동은 트리 종료 → 포트 해제 확인 → 같은 셸 id 에 새 PTY. 중지도 있다.
- `src/ipc/developmentProcess.js`: 로그에서 루프백 주소·시작 포트를 읽는다.
- 화면:
  - `Terminal/DevelopmentRunStatus.tsx`: 사이드바·탭의 상태 칩. 재기동·중지·브라우저로 열기·로그 보기.
  - `lib/developmentRun.ts`: 상태 스토어.

없는 것: 구성 저장, 카드에 늘 보이는 버튼, 오류 판정·알림, 에이전트 조작, JDK, 레거시, 바로 반영.

## 정한 것 (2026-11-25, 사용자와 대화)
| 항목 | 결정 |
|---|---|
| 알림 범위 | 화면에는 멈춤(비정상 종료)과 실행 중 오류 묶음 둘 다. Windows 알림은 멈춤만 |
| 저장 위치 | 이 PC 에만 (`userData`, main 소유). 저장소 파일 공유는 나중 |
| 앱을 켤 때 자동 실행 | 없음 (1단계). 나중에 구성별 선택 |
| 오류를 에이전트에게 자동으로 보내기 | 없음. 사용자가 알림에서 `에이전트에게 보내기` 를 누를 때만 |
| 에이전트 조작 허용 | 구성마다 스위치, 기본 켜짐 |

## 1단계: 실행 구성·카드 버튼·오류 알림·에이전트 조작·JDK 보관함

### 실행 구성
- 프로젝트(로컬 작업의 프로젝트 키: 기본 체크아웃 경로, `lib/localProjectServers.ts` 의 `projectKeyOf` 와 같은 값)마다 여러 개.
- 구성은 프로젝트에서 공유한다. 카드가 놓인 워크트리 또는 에이전트 셸의 워크트리가 실행 루트다. 같은 구성을 워크트리마다 별도의 셸에서 실행할 수 있고, 상태와 오류도 워크트리마다 둔다.
- 한 구성의 필드:
  - `id`, `name`(20자)
  - `relative`: 프로젝트 루트 기준 폴더
  - 실행 방식: `task`(main 이 찾은 후보 id) 또는 `custom`(사용자가 입력한 명령)
  - `jdk`: 보관함의 JDK id. 없으면 `system` (PC 의 `JAVA_HOME`·`PATH` 그대로)
  - `env`: 추가 환경 변수 (이름 `[A-Z_][A-Z0-9_]*`, 값 한 줄, 20개)
  - 스위치: `notify`(오류 알림), `agentControl`(에이전트 조작), `inAll`(`모두 실행` 에 포함)
  - `order`, `waitReady`(`모두 실행` 때 앞 구성이 뜬 뒤 실행)
- 저장: `userData/run-presets.json`. main 이 읽고 쓰고, 읽을 때 형식을 다시 검사한다. 쓰기는 임시 파일에 쓴 뒤 이름을 바꾼다.
- 바꾸면 안 되는 것 (명령):
  - `task` 는 실행할 때마다 `prepareDevelopmentTask` 로 다시 확정한다. 저장된 명령 글자를 실행하지 않는다.
  - `custom` 명령은 본창 설정 화면에서 사용자가 입력한 것만 저장한다 (IPC 는 본창 주 프레임·잠금 해제).
  - 저장 후 처음 실행할 때 명령 전체를 보여 주고 한 번 확인받는다. 명령이 바뀌면 다시 확인받는다.
  - 에이전트·MCP·휴대폰은 구성을 만들거나 고칠 수 없다. 이름으로 실행만 한다.
  - 에이전트 조작을 허용하면 에이전트가 프로젝트의 빌드 스크립트를 샌드박스 밖에서 실행할 수 있다. main 은 요청받은 구성 이름으로 그 워크트리의 실제 폴더와 실행 후보를 다시 확인한다.
- 실행 폴더는 해당 워크트리 안이어야 한다 (`resolveInside`와 같은 검사, 링크를 푼 실제 경로 기준).
- 한계. 확인 해시는 앱의 확인 여부를 기억한다. 같은 OS 사용자로 실행되어 `run-presets.json`을 수정할 수 있는 프로세스는 해시도 다시 쓸 수 있다.

### 카드 버튼 (사이드바 로컬 작업 카드)
- 시안 장면 1·3·4·5·8.
- 구성이 없으면 점선 `＋ 실행 구성 추가` 를 보인다.
- 구성이 있으면 줄마다 다음을 보인다:
  - 종류 아이콘, 이름, 폴더
  - 상태: 멈춤 / 시작 중 N초 / 실행 중 `:포트` / 멈춤·종료 N / 오류 N
  - 버튼: ▶ 실행 / ↻ 재기동 / ■ 중지 / 열기 / 로그, 그리고 `⋯`(수정·삭제·순서)
- 머리줄에 `모두 실행` / `모두 중지` 를 둔다.
- 실행은 지금의 개발 서버 PTY 경로를 그대로 쓴다. 탭은 지금처럼 그 워크트리 묶음에 생긴다.
- 구성 추가·수정 창: 시안 장면 2. 폴더 고르기 → 그 폴더의 후보 목록(라디오) 또는 `직접 입력`. 스위치들과 JDK 선택.

### 시작 완료와 오류 판정 (main, 새 모듈 `src/ipc/developmentErrors.js`)
- **시작 완료:**
  - 지금의 주소·포트 판독
  - 프레임워크 문구: `Started .* in .* seconds`, `Local:\s+http`, `Server startup in`, `ready in .* ms`
  - 시작 완료 전에 끝나면 멈춤이다.
- **멈춤:** PTY 가 0 이 아닌 코드로 끝남.
- **오류 묶음:** 실행 중 로그에서 잡는다. 알려진 문구를 먼저 본다:
  - `APPLICATION FAILED TO START`, `Port \d+ was already in use`, `EADDRINUSE`
  - `Failed to compile`, `[vite] Internal server error`, `error TS\d+`
  - `BUILD FAILURE`, `FAILURE: Build failed`, `[ERROR]`, `SEVERE`
  - 그다음 일반 규칙: 로그 수준 낱말 ERROR·FATAL, 예외 이름과 이어지는 `at …` 스택 줄은 한 묶음.
  - 일반 규칙은 화면의 `lib/logLevels.ts`·`lib/logProblems.ts` 와 같아야 한다. 가능하면 main 에서도 같은 규칙을 쓰고, 어렵다면 같은 시험 표본으로 둘의 결과가 같은지 본다.
- 구성마다 최근 오류 묶음 20개와 각 묶음의 줄(최대 80줄)을 메모리에만 둔다. 디스크에 쓰지 않는다.
- 재기동하면 비운다.

### 알림 (화면)
- 멈춤:
  - 칩을 빨강으로 바꾸고 앱 안 알림(시안 장면 6)을 띄운다.
  - 창이 뒤에 있으면 작업 표시줄 깜빡임과 Windows 알림을 띄운다.
  - Windows 알림 본문은 `<프로젝트> · <구성 이름>이 멈췄습니다` 뿐이다. 로그 내용은 넣지 않는다 (알림 센터에 남는다).
- 오류 묶음: 칩에 `오류 N` 만 붙이고 알림은 띄우지 않는다. 배지를 누르면 그 탭의 첫 오류 줄로 간다.
- 같은 구성의 같은 멈춤은 한 번만 알린다.

### 에이전트에게 보내기 (화면, 시안 장면 7)
- 대상: 같은 프로젝트의 셸에서 도는 에이전트 목록. 역할·상태와 함께 보인다.
- 보내는 것: 구성 이름·프로젝트 기준 상대 폴더·실행 방식 이름·종료 코드와 마지막 오류 묶음(최대 80줄), 사용자가 덧붙인 말. main이 미리보기에 반환한 본문에 메모를 붙여 보낸다.
- 에이전트 메시지 경로로 보낸다. 보낸 사람은 `user` 다.

### 에이전트 조작 (MCP, `ezshell-cli-mcp` 에 도구 추가)
| 도구 | 하는 일 |
|---|---|
| `run_list` | 부른 에이전트의 프로젝트에 있는 구성: 이름, 상태, 포트, 오류 수, `agentControl` |
| `run_start(name)` / `run_restart(name)` / `run_stop(name)` | 실행·재기동·중지 |
| `run_wait(name, seconds≤300)` | 시작 완료·멈춤·제한 시간 중 먼저 오는 것을 기다려 결과를 돌려준다 |
| `run_log(name, { lines≤400 } \| { errors: true })` | 마지막 N줄, 또는 오류 묶음만. 색 코드·제어 문자는 뺀다 |

- 바꾸면 안 되는 것:
  - 부른 에이전트가 셸에 묶여 있어야 한다 (`shellId` 있음, Aside 같은 셸 없는 에이전트는 거부).
  - 그 셸의 폴더가 구성의 프로젝트 안이어야 한다.
  - `agentControl` 이 꺼지면 시작·재기동·중지를 거부한다. `run_list`, `run_wait`, `run_log`는 사용할 수 있다.
- 에이전트가 구성을 처음 시작하거나 재기동하면 누가 조작했는지와 허용을 끄는 버튼을 앱 안에 한 번 보여 준다. 안내 여부는 모든 워크트리가 공유하는 프로젝트 구성에 저장한다.
- 사용자가 해당 워크트리에서 30초 안에 직접 중지한 구성은 에이전트의 `run_start`·`run_restart` 를 거부한다 ("사용자가 방금 중지했습니다").
- 조작 기록은 메모리에 남는다 (구성마다 최근 20개: 누가·무엇을·언제). 카드 줄에 "codex-5 가 재기동 · 4초 전" 을 10초 보이고, 줄의 기록 보기에 남는다.
- 잠금 중에는 모든 `run_*` 를 거부한다.
- 문서의 기존 규칙("재기동·중지 IPC 를 MCP 에 노출하지 않는다")은 이 방식으로 고쳐 적는다. 에이전트는 사용자가 만든 구성을 이름으로만 부르고 명령·폴더를 넘기지 못한다.

### JDK 보관함 (main, 새 폴더 `src/runtimes/`)
- **받기:**
  - Eclipse Temurin: Adoptium API `api.adoptium.net/v3/assets/feature_releases/<ver>/ga`. 파일은 GitHub 릴리스에 있다.
  - Azul Zulu: `api.azul.com/metadata/v1/zulu/packages`.
  - JDK 6·7 은 무료 배포가 없다 (2026-11-25 확인: Azul 무료 메타데이터에 Windows x64 6·7 ZIP 이 없고, 6·7 최신 빌드는 구독자용이다). 6·7 을 고르면 그렇다고 알리고 대안을 준다: 이 PC 에서 찾은 6·7 쓰기, 또는 JDK 8 로 받기 (대부분의 6·7 프로젝트와 옛 Tomcat 은 JDK 8 에서 돈다). 컴파일 버전(-source/-target)은 2단계에서 맞춘다.
  - 버전·OS·CPU 로 zip(Windows)·tar.gz(mac·Linux)와 SHA-256 을 받는다.
- **바꾸면 안 되는 것:**
  - https 만 쓴다.
  - 신뢰의 기준점은 `api.adoptium.net`·`api.azul.com`의 TLS다. 파일 주소와 SHA-256은 같은 공급자 API 응답에서 받는다.
  - 정해진 호스트만 받는다: `api.adoptium.net`, `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `api.azul.com`, `cdn.azul.com`. 리다이렉트도 같은 목록 안에서만 따라간다. 단계마다 https·호스트를 다시 보고, 5번까지 따라간다.
    - `release-assets…` 는 2026-11-25 실측으로 더했다: Adoptium 이 준 GitHub 주소가 302 로 그 호스트에 보낸다.
  - SHA-256 이 맞아야 푼다.
  - 압축은 쓰기 전에 모든 항목의 경로를 검사한다 (`dbClient/unzip.js` 의 `safeTarget` 재사용). tar.gz 는 Node 로 직접 풀거나, 목록을 먼저 검사한 뒤 시스템 `tar` 로 푼다.
  - 받는 중에는 임시 폴더에 두고, 다 끝난 뒤 이름을 바꾼다.
- 위치: `userData/runtimes/jdk/<vendor>-<버전>-<arch>/`. 목록은 `userData/runtimes.json`.
- **찾기 (이미 깔린 JDK):**
  - `Program Files\Java`, `Program Files\Eclipse Adoptium`, `Program Files\Zulu`
  - `~/.jdks`, `~/.gradle/jdks`
  - mac 은 `/Library/Java/JavaVirtualMachines`
  - `JAVA_HOME`
  - `release` 파일로 버전을 읽는다.
- **적용:**
  - 그 구성의 PTY 환경에만 넣는다: `JAVA_HOME=<jdk>`, `PATH=<jdk>\bin;…`.
  - OS 환경 변수·레지스트리·사용자 프로필은 바꾸지 않는다 (사용자 요구).
- **필요한 버전 추정:**
  - `pom.xml` 의 `maven.compiler.source`/`release`/`java.version`
  - Gradle `sourceCompatibility`/toolchain
  - Spring Boot 3.x 면 17 이상
  - 맞는 JDK 가 없으면 구성 창과 첫 실행에서 "JDK 17 이 필요합니다. 받을까요?"
- **화면:** 설정 > `개발 도구`(새 탭) 에 받은 것·찾은 것 목록, 크기, 지우기, 받기를 둔다. 받기 전에 라이선스 링크를 보인다.
- IPC: 받기·지우기는 본창 주 프레임·잠금 해제. 에이전트·MCP 에는 없다.
- 새 `src/` 폴더라서 `MAIN_RUNTIME_DIRECTORIES` 에 `runtimes` 를 더한다.

### 시험
- 단위:
  - 구성 검사(폴더 밖, 이름, env, custom 확인)
  - 오류 판정 표본: Spring, Vite, vue-cli, Gradle, Maven, Tomcat 로그 실제 표본
  - 시작 완료 판정
  - `run_*` 권한(셸 없음, 다른 프로젝트, agentControl 꺼짐, 사용자 중지 30초, 잠금)
  - JDK API 응답 해석, 체크섬 불일치 거부, 경로 탈출 거부, 호스트 목록
- 화면: `local-development-tasks` 명세를 넓힌다. 가짜 서버 명령으로 구성 추가 → ▶ → 시작 완료 칩 → 오류 줄 → `오류 1` → 강제 종료 → 멈춤 알림 → 재기동.
- JDK 실제 받기는 사용자 PC 에서 한 번 확인한다 (시험은 가짜 서버). Windows에서 Temurin 21과 Zulu 8을 받아 압축 항목 수가 상한 안에 드는지 확인한다.

### 1단계 작업 나눔과 IPC 계약
세 사람이 함께 만든다. 이름은 이대로 쓰고, 바꿔야 하면 PL 에게 먼저 알린다.

- **main (codex-5)**
  - 구성 저장·검사, 실행 연결(JDK·env 주입), `developmentErrors.js`, `run_*` MCP 도구, 조작 기록.
  - preload 의 `electronAPI` 이름도 이 사람이 더한다.
- **화면 (claude-1)**
  - 카드 버튼·구성 창·알림·에이전트에게 보내기 창.
  - main 이 준비되기 전에는 가짜 응답으로 만든다.
- **JDK 보관함 (codex-4)**
  - `src/runtimes/`, 설정 > 개발 도구 탭.
  - main 쪽에 `runtimes.javaHomeOf(id) → 절대 경로 | null` 을 내보내면 codex-5 가 실행 때 부른다.

IPC 는 모두 본창 주 프레임·잠금 해제에서만 받는다. `worktreeFolder`는 카드가 놓인 워크트리 폴더다. 목록과 이벤트의 `worktreeKey`는 화면의 `pathKey`와 같은 정규화 키다. `presets`는 프로젝트가 공유하고 `states`는 요청한 워크트리 기준이다.

| 채널 | 요청 → 응답 |
|---|---|
| `run-presets-list` | `(worktreeFolder)` → `{ projectKey, worktreeKey, presets: Preset[], states: Record<id, RunState> }` |
| `run-presets-candidates` | `(worktreeFolder, relative)` → `{ candidates: [{ taskId, name, command }] }` (그 폴더의 후보만. command 는 보여 주기용) |
| `run-presets-save` | `(worktreeFolder, preset)` → `{ preset }` 또는 오류. id 가 없으면 새로 |
| `run-presets-delete` | `(worktreeFolder, id)` |
| `run-presets-reorder` | `(worktreeFolder, ids[])` |
| `run-preset-start` / `-restart` / `-stop` | `(worktreeFolder, id, { confirmCustom?: true, confirmInstall?: true })` → `{ ok }`, `{ needsConfirm: { command } }`(직접 명령 첫 실행) 또는 `{ needsInstall: { command } }`(의존성 설치 필요, 이번 실행에만 확인) |
| `run-preset-start-all` / `-stop-all` | `(worktreeFolder, 같은 확인 필드)` → 확인이 필요한 구성이 있으면 하나씩 같은 형식으로 돌려준다. 모두 중지는 전환 중인 구성을 최대 10초 기다린 뒤 멈춘다 |
| `run-preset-errors` | `(worktreeFolder, id)` → `{ groups: [{ at, lines: string[] }] }` |
| `run-preset-send-preview` | `(worktreeFolder, id)` → `{ text }` (메모를 붙이기 전 본문) |
| `run-preset-send` | `(worktreeFolder, id, agentId, note)` → `{ ok }` (에이전트에게 보내기) |
| 이벤트 `run-preset-state` | `{ projectKey, worktreeKey, id, state: RunState, firstAgentAction?: true }` (처음 에이전트 조작은 `state.lastAction`으로 표시) |

```ts
type Preset = { id: string; name: string; relative: string; kind: 'task' | 'custom'; taskId?: string; command?: string
  jdk: string | 'system'; env: Record<string, string>; notify: boolean; agentControl: boolean; inAll: boolean; waitReady: boolean }
type RunState = { status: 'idle' | 'starting' | 'running' | 'stopped' | 'crashed'; exitCode?: number | null; address?: string
  startedAt?: number; readyAt?: number; errors: number; shellId?: string /* 화면이 탭·칸을 찾는다 */
  lastAction?: { by: 'user' | string /* agent id */; action: 'start' | 'restart' | 'stop'; at: number } }
```

- `stopped` 는 사용자·에이전트가 멈춘 것, `crashed` 는 스스로 0 이 아닌 코드로 끝난 것이다.
- `custom` 의 `command` 는 화면에 보여 주기 위해서만 돌려준다. 실행은 main 이 저장된 값으로 한다.
- 의존성 설치(`installCommand`)도 main 이 다시 확정한 것만 실행한다. 에이전트의 `run_*` 가 설치를 만나면 거부하고, 사용자가 카드에서 한 번 실행하라고 알린다.
- sparse checkout 으로 빠진 폴더의 task 는 1단계에서 후보로 내지 않는다.

## 2단계: 레거시 (Ant·Tomcat·이클립스·Maven)
- **실행 구성을 "준비 + 서버" 두 단계로:**
  - 준비: Ant 타깃(`build.xml` 의 `<target name>` 에서 고름), Maven 목표, 또는 "이클립스식 빌드"(아래).
  - 실패하면 "빌드 실패" 로 알린다.
- **Tomcat 런타임:**
  - Tomcat 폴더와 JDK 를 등록한다.
  - 구성마다 전용 `CATALINA_BASE` 를 `userData/runtimes/tomcat-base/<구성 id>/` 에 만든다 (conf 복사, 포트, `Context docBase` 를 프로젝트 웹 폴더로).
  - `catalina run` 을 PTY 로 돌린다. 설치된 Tomcat 설정은 바꾸지 않는다.
  - JSP·정적 파일 수정은 재기동 없이 반영된다.
  - 시작 완료는 `Server startup in`, 오류는 `SEVERE`·배포 실패 문구로 판단한다.
- **이클립스 설정 가져오기:**
  - `.classpath`(소스·lib·출력), `org.eclipse.wst.common.component`(배포 구성·컨텍스트 경로), `org.eclipse.jdt.core.prefs`(컴파일 버전·인코딩)
  - 워크스페이스 `Servers` 프로젝트의 `server.xml`·`context.xml`(JNDI), 서버 `.launch` 의 VM 인자
  - "워크스페이스 폴더 선택" 한 번으로 구성을 미리 채운다.
- **손으로 고칠 칸:** 클래스패스(lib 폴더·jar·순서), JDK, 소스 인코딩, 컴파일 버전, VM 인자, 컨텍스트 경로, 포트, JNDI 데이터소스, 기동 전 복사·연결할 파일.
- **이클립스식 빌드:** 가져온 클래스패스로 `javac` 를 돌려 `WEB-INF/classes` 로 컴파일한다. 처음은 전체, 다음은 바뀐 파일만. `build.xml` 이 깨진 프로젝트용이다.
- **로그 인코딩:** 구성마다 고른다 (자동 판정 + MS949·UTF-8).
- **실패 진단과 제안:** 사용자가 승인해야 반영한다.

  | 로그 | 제안 |
  |---|---|
  | `ClassNotFoundException` | 그 클래스가 든 jar 를 찾아 클래스패스에 추가 |
  | `UnsupportedClassVersionError` | 맞는 JDK |
  | `NameNotFoundException jdbc/…` | JNDI 칸 |
  | `unmappable character` | 소스 인코딩 |
  | 포트 사용 중 | 쓰는 프로세스 표시 |

- **Maven:**
  - 실패 분류: HTTP 저장소 차단, 사라진 저장소, 401, 옛 JDK 의 TLS, 어디에도 없는 jar, 플러그인·JDK 불일치.
  - 우회: 프로젝트 전용 `settings.xml`(`-s`, 사용자의 `~/.m2/settings.xml` 은 그대로)로 사라진 저장소를 대체 주소나 로컬 보관소로 돌린다.
  - Maven 은 최신 TLS 가 되는 JDK 로 돌리고, 컴파일은 toolchains 로 프로젝트 JDK 를 쓴다.
  - 없는 jar 는 `~/.m2`·`lib`·사용자가 가리킨 폴더에서 찾아 프로젝트 전용 보관소에 넣는다.
  - 성공한 의존성·플러그인을 보관소에 고정한다 (이 PC, 또는 저장소의 `.mvn-repo/`).
  - `pom.xml` 수정은 사용자가 승인할 때만 한다.
- **에이전트가 들어갈 자리:**
  - "기동 맞추기 맡기기": 에이전트가 `run_log` 를 읽고 구성 변경을 제안한다 (jar 추가·JDK·저장소 대체).
  - 변경은 사용자가 화면에서 보고 승인할 때만 반영한다. 클래스패스·VM 인자는 실행 내용이라 에이전트가 직접 바꾸지 못한다.
- **보관함 넓히기:** Maven·Ant·Gradle·Tomcat·Node 받기. Apache 는 SHA-512, Node 는 SHASUMS. 1단계 JDK 보관함과 같은 규칙을 따른다.

### 2단계 첫 묶음: 도구 받기와 Tomcat 실행 (2026-11-26, PL 결정. 사용자 확인 전)
이클립스 가져오기·Maven 우회·실패 진단은 사용자의 실제 프로젝트 정보를 받은 뒤에 한다. 이번에는 프로젝트 정보 없이 되는 것만 만든다.

- **도구 (codex-4):** Tomcat 7·8.5·9·10.1·11, Maven 3.6·3.8·3.9, Ant 1.9·1.10 받기와 이 PC 에서 찾기. Tomcat 6 은 공식 SHA-512 가 없어 받지 않는다 (찾은 것은 쓸 수 있다). main 에 `runtimes.toolHomeOf(id) → 절대 경로 | null`.
- **구성 종류 `tomcat` (codex-5 main, claude-1 화면):**
  ```ts
  type TomcatPreset = Preset & { kind: 'tomcat'
    tomcat: string        // 보관함·찾은 Tomcat 의 id
    webapp: string        // 프로젝트 루트 기준, WEB-INF 가 든 펼친 웹 폴더 (WebContent, src/main/webapp, target/<이름>)
    contextPath: string   // '/' 또는 '/이름'
    port: number          // HTTP, 기본 8080
    vmArgs: string        // 한 줄, CATALINA_OPTS 에 들어감
    prepare?: { tool: 'ant', target: string } | { tool: 'maven', goals: string }  // 기동 전 빌드
  }
  ```
  - `vmArgs`·`prepare` 는 실행 내용이다. 직접 입력 명령과 같이 본창에서만 저장하고, 확인 해시에 넣어 바뀌면 다시 확인받는다. 에이전트·MCP 는 고칠 수 없다.
  - Ant 타깃은 실행할 때 `build.xml` 의 `<target name>` 목록에 있는지 다시 본다. Ant·Maven 은 보관함의 것, 없으면 PATH.
  - 준비가 실패하면 "빌드 실패" 로 멈춤 처리하고 서버를 띄우지 않는다.
- **CATALINA_BASE:** 실행마다 `userData/runtimes/tomcat-base/<구성 id>/` 를 다시 만든다.
  - 설치된 Tomcat(`CATALINA_HOME`)의 `conf/` 를 복사하고 `server.xml` 의 HTTP 포트를 구성 값으로, 종료 포트는 `-1`, AJP 커넥터는 뺀다. `Host` 의 `autoDeploy`·`deployOnStartup` 은 끄고 `appBase` 는 base 안의 빈 폴더.
  - `conf/Catalina/localhost/<컨텍스트>.xml`(루트는 `ROOT.xml`)에 `<Context docBase="<웹 폴더 실제 경로>"/>`. 웹 폴더는 워크트리 안이어야 한다 (실제 경로 검사).
  - `logs`·`temp`·`work` 도 base 안. 바꾸면 안 되는 것: `CATALINA_HOME` 의 파일은 읽기만 한다.
- **실행:** `<home>\bin\catalina.bat run` (mac·Linux `catalina.sh run`). PTY 환경에만 `CATALINA_HOME`·`CATALINA_BASE`·`JAVA_HOME`·`CATALINA_OPTS`. 시작 완료 `Server startup in`, 오류 `SEVERE`·배포 실패 (1단계 판정에 이미 있음).
- **바로 반영 (Tomcat):** `CATALINA_OPTS` 에 JDWP 인자. Tomcat 은 웹 앱 클래스가 `java.class.path` 에 없으므로 클래스패스를 JVM 에 묻지 않고 만든다: `WEB-INF/classes` + `WEB-INF/lib/*.jar` + `CATALINA_HOME/lib/*.jar`. 출력은 `WEB-INF/classes`, 소스 루트는 이클립스 `.classpath` 의 `src` 항목, 없으면 `src/main/java`·`src`. JSP·정적 파일은 Tomcat 이 스스로 다시 읽는다.

## 3단계: 바로 반영 (JRebel 처럼 재기동 없이 Java 수정 적용)
- **목표:** Java 파일을 저장하면(사용자든 에이전트든) 몇 초 안에 실행 중인 서버에 반영한다. 안 되는 변경이면 "재기동이 필요합니다" 와 재기동 버튼을 띄운다.
- **흐름:**
  1. 소스 폴더를 감시한다 (`fs.watch`, 200ms 묶음).
  2. 바뀐 `.java` 만 그 구성의 클래스패스로 `javac` 한다.
     - 클래스패스는 Maven `dependency:build-classpath`, Gradle init 스크립트로 `runtimeClasspath`, 이클립스 `.classpath` 에서 얻고 기억한다.
     - 출력은 실행 중인 서버가 읽는 클래스 폴더(`target/classes`, `build/classes/java/main`, `WEB-INF/classes`)다.
  3. 바뀐 클래스(내부 클래스 `$` 포함)를 JVM 에 다시 적재한다. 등급은 아래 두 가지.
- **등급 A: 표준 HotSwap**
  - 모든 JDK(6 이상)에서 된다. 메서드 몸체 수정만 된다.
  - 실행할 때 JVM 에 디버그 에이전트를 붙인다: `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:<빈 포트>`.
  - main 의 작은 JDWP 클라이언트(`src/runtimes/jdwp.js`)가 `ClassesBySignature` → `RedefineClasses` 로 바꾼다.
  - 메서드 추가·필드 추가·상속 변경은 JVM 이 거부한다. 그때 "재기동 필요" 를 띄운다.
- **등급 B: 확장 HotSwap (JRebel 에 가까움)**
  - JetBrains Runtime SDK 17·21과 HotswapAgent 2.x를 쓴다.
  - 메서드·필드 추가·삭제와 Spring 빈 다시 읽기, MyBatis 매퍼 XML, Hibernate 엔티티 일부까지 된다.
  - JDK 8·11에는 표준 등급을 쓴다.
  - 개발 도구 설정에서 JBR SDK와 HotswapAgent를 받는다. GPL-2.0 라이선스는 HotswapAgent 받기 버튼 옆에서 볼 수 있다.
  - 표준과 같은 JDWP 요청으로 컴파일 결과를 적용한다.
- **JVM 인자를 넣는 자리:**
  - Maven: `-Dspring-boot.run.jvmArguments=…`
  - Gradle: init 스크립트(`-I`, 앱 폴더)로 `bootRun.jvmArgs`
  - Tomcat: `CATALINA_OPTS`
  - `JAVA_TOOL_OPTIONS` 는 쓰지 않는다. Gradle·Maven 자체 JVM 에도 붙어 포트가 겹친다.
- **Spring Boot DevTools 가 이미 의존성에 있으면:** 그 빠른 재시작을 쓰고 2번 컴파일만 한다. 의존성을 더하지는 않는다.
- **바꾸면 안 되는 것:**
  - JDWP 는 인증이 없다. 루프백(`127.0.0.1`)에만, 실행마다 새 빈 포트로 연다.
  - 바로 반영을 켠 구성에서만 연다. 끄면 디버그 에이전트 없이 실행한다.
  - 원격 디버깅 포트를 화면이나 MCP 로 알려 주지 않는다.
- **에이전트:** `run_log` 에 "바로 반영됨 · 클래스 3개" 또는 "재기동 필요: 메서드 추가" 가 남는다. 에이전트가 고친 뒤 결과를 확인할 수 있다.
- **한계:** JRebel 도 못 하는 것과 비슷하다. 상속 구조, 정적 초기화, 프레임워크 설정 파일 일부는 재기동이 필요하다. 이건 화면에 그대로 알린다.

### 3단계에서 정한 것 (2026-11-26, PL 결정. 사용자가 출근해 있어 확인받지 못함. 사용자가 확인한 뒤 바꿀 수 있다)
| 항목 | 결정 |
|---|---|
| 대상 | Spring Boot 실행 후보(`task`, Maven `spring-boot:run`·Gradle `bootRun`)만. 직접 입력 명령·Node 는 안 된다. Tomcat 은 2단계에서 `CATALINA_OPTS` 로 붙인다 |
| 구성 필드 | `hotReload: 'off' \| 'standard' \| 'enhanced'`, 기본 `'off'`. 옛 파일에 없으면 `'off'` |
| 클래스패스 | Maven·Gradle 을 따로 돌리지 않는다. 붙은 JVM 에 JDWP `VirtualMachine.ClassPaths`(1/13)로 묻는다. 서버가 실제로 쓰는 클래스패스이고, 네트워크·빌드 도구 실행이 없다 |
| 출력 폴더 | 그 클래스패스 중 워크트리 안의 폴더(`target/classes`, `build/classes/java/main`). 소스 루트는 그 짝(`src/main/java`) |
| DevTools | 의존성에 `spring-boot-devtools` 가 있으면 JDWP 를 붙이지 않고 컴파일만 한다 (DevTools 가 다시 시작한다) |
| 확장 등급 | JDK 17·21 만 (JBR). JDK 8·11 프로젝트는 표준만 (DCEVM 8·11 은 받지 않는다) |
| IDE 디버거 | 바로 반영을 켠 실행에는 IDE 디버거를 붙일 수 없다 (JDWP 는 한 번에 하나만 붙는다). 구성 창에 적는다 |

### 3단계 흐름의 세부 (바꾸면 안 되는 것 포함)
- **JVM 인자:** `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,quiet=y,address=127.0.0.1:<빈 포트>`.
  - `quiet=y` 로 JVM 의 `Listening for transport dt_socket at address: N` 줄을 막는다. 그 줄이 터미널·`run_log` 에 포트를 드러내고, `developmentProcess.js` 의 주소 판독이 그 포트를 서버 주소로 잘못 읽을 수 있다.
  - Maven(Windows 는 PowerShell `-EncodedCommand`): `'-Dspring-boot.run.jvmArguments=<인자>'` 를 작은따옴표로 감싸 명령 끝에 붙인다. PowerShell 은 따옴표 없는 `-Dname.with.dot=…` 를 점에서 나눈다.
  - Windows의 확장 인자는 PTY의 `EZSHELL_HOT_RELOAD_MAVEN_OPTIONS`를 Maven이 `${env.EZSHELL_HOT_RELOAD_MAVEN_OPTIONS}`로 펼친다. `.cmd` 래퍼가 공백·작은따옴표가 든 에이전트 경로를 다시 해석할 필요가 없다. 디버그 포트는 이 변수에 넣지 않는다.
  - Gradle: 앱이 쓰는 고정 init 스크립트(`userData/hot-reload/init.gradle`)를 `-I` 로 넘기고, 인자는 PTY 환경 변수 `EZSHELL_HOT_RELOAD_JVM_ARGS` 로 준다. 스크립트는 `bootRun` 의 `jvmArgs` 에만 더한다.
- **연결에서 바꾸면 안 되는 것:** 실행 직후부터 JVM이 종료될 때까지 루프백 JDWP 연결을 유지하고, 끊기면 바로 재접속한다. 잠금·클래스패스 확인 실패·감시 오류에도 인증 없는 포트를 비워 두지 않는다. 잠금 중 감시와 컴파일을 멈추고 재접속 핸드셰이크 외에 JVM 명령을 보내지 않는다. JVM이나 앱이 종료될 때 연결을 닫는다. `ClassPaths`의 출력 폴더는 실제 경로가 워크트리 안인지 검사한 뒤 사용한다.
- **포트:** 실행마다 새로 고른다. 화면·MCP·`run_log`·`run_list`·로그 파일 어디에도 내보내지 않는다.
- **감시:** 소스 루트를 `fs.watch`(재귀)로 본다. 마지막 변경 뒤 300ms 조용하면 묶어서 한 번 처리한다. 상태가 `running` 일 때만. 처리 중 생긴 변경은 다음 묶음으로 미룬다. `.java` 삭제는 클래스를 지우지 않는다.
- **컴파일:** 그 구성의 JDK 의 `javac`(구성이 `system` 이면 PTY 와 같은 `JAVA_HOME`·`PATH` 규칙). JRE 만 있으면 "javac 를 찾을 수 없습니다".
  - `execFile`(셸 없음) + 인자 파일(`@파일`, Windows 명령 길이 32K 제한). 60초 제한.
  - 인자: `-d <출력 폴더> -cp <JVM 클래스패스> -implicit:none -g -parameters -encoding <pom/gradle 의 소스 인코딩, 없으면 UTF-8>` 와 기존 `.class` 의 major 버전에 맞춘 `--release N`(javac 8 이면 `-source/-target`).
  - Lombok: 빌드 파일에 lombok 이 있고 JVM 클래스패스에 없으면 `~/.m2`·Gradle 캐시에서 jar 를 찾아 `-processorpath` 로 준다. 못 찾으면 컴파일 오류로 알린다.
  - 컴파일 오류는 그 실행의 오류 묶음에 넣는다 (`오류 N`, 에이전트에게 보내기에 그대로 쓰인다).
- **적용:** 바뀐 소스에서 나온 클래스(`$` 내부 클래스 포함)를 `ClassesBySignature` 로 찾아 `RedefineClasses`. 아직 적재되지 않은 클래스는 파일만 쓰면 된다 (처음 쓸 때 적재된다). 여러 클래스 로더에 있으면 모두 바꾼다.
  - JDWP 오류 63·64·66·67·70·71·72는 "재기동 필요: 메서드 추가"처럼 표시한다. 그 외 오류는 반영 실패로 표시한다. 다시 정의하는 요청은 60초까지 기다린다. 시간 안에 응답이 없으면 반영 여부를 확인할 수 없다고 표시한다.
- **확장 등급:** 표준과 같은 컴파일·적용 흐름에 `-XX:+AllowEnhancedClassRedefinition`, `-XX:HotswapAgent=external`, `-javaagent:<앱 보관함 JAR의 절대 경로>`를 추가한다. 외부 에이전트 모드에서 JBR이 필요한 모듈을 열어 준다. JAR는 앱 프로필의 `runtimes/hotswap-agent/<버전>/hotswap-agent.jar`에 둔다. [HotswapAgent 공식 실행 안내](https://github.com/HotswapProjects/HotswapAgent#quick-start)
- **JBR SDK 신뢰 기준:** `api.github.com`의 JetBrains/JetBrainsRuntime 공식 릴리스가 가리키는 `jbrsdk` 주소와 `cache-redirector.jetbrains.com` 및 허용 CDN의 TLS 응답을 신뢰한다. 공식 `.checksum`의 SHA-512를 파일과 비교해 다운로드 손상과 파일 혼동을 검출한다. 아카이브와 체크섬 모두 JetBrains가 관리하는 CDN에서 받으므로 그 CDN이 침해되면 두 값이 함께 바뀔 수 있다. 검증한 아카이브의 경로를 검사한 뒤 임시 폴더에 풀고, 이름을 바꿔 설치한다. [JetBrains Runtime 릴리스](https://github.com/JetBrains/JetBrainsRuntime/releases)
- **HotswapAgent 신뢰 기준:** `api.github.com` TLS 응답에서 HotswapProjects/HotswapAgent 공식 공개 2.x 릴리스 자산에 대해 GitHub가 계산한 `digest`를 신뢰한다. 릴리스 게시 권한이 침해되면 새 자산에도 유효한 해시가 붙을 수 있다. 검증한 SHA-256과 크기를 JAR와 함께 기록하고 설치 폴더는 이름 바꾸기로 게시한다. [HotswapAgent 릴리스](https://github.com/HotswapProjects/HotswapAgent/releases)
- **추가 HTTPS 호스트:** `api.github.com`, `cache-redirector.jetbrains.com`, `d2xrhe97vsfxuc.cloudfront.net` (JetBrains 다운로드 CDN). GitHub 자산은 기존에 허용된 `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`을 사용한다. 리디렉션도 같은 호스트 허용 목록으로 검사한다.

### 3단계 작업 나눔과 계약
- **codex-4: JDWP 클라이언트와 확장 등급 받기**
  - `src/runtimes/jdwp.js`: 핸드셰이크, `IDSizes`(1/7), `CapabilitiesNew`(1/17), `ClassPaths`(1/13), `ClassesBySignature`(1/2), `RedefineClasses`(1/18), 오류 코드 → 한국어 이유. VM 이 먼저 보내는 이벤트 패킷은 읽고 버린다. 응답 제한 시간.
  - `src/runtimes/classFile.js`: `.class` 의 이름·major 버전 읽기.
  - 시험: 가짜 JDWP 서버로 단위 시험. 이 PC 의 JDK 17(`C:\DEV\JAVA\zulu17…`)로 작은 Java 프로그램을 띄워 실제로 몸체를 바꾸고, 메서드 추가가 거부되는지 한 번 확인한다 (손으로 돌리는 스크립트, 결과를 보고에 적는다).
  - 보관함에 JBR 17·21 과 HotswapAgent 받기 (1단계 JDK 받기 규칙: 정해진 호스트, https, 체크섬, 경로 검사). 설정 > 개발 도구에 목록·받기·지우기. 신뢰의 기준점과 호스트 목록은 이 문서에 적는다.
  - main의 `runtimes.enhancedJvmArgs(jdkId)`는 보관함의 JBR과 검증된 HotswapAgent가 있으면 위 인자 세 개를 배열로 돌려주고, 그 외에는 `null`을 돌려준다.
  - 화면의 `runtimes-list` 응답은 `jdks`에 `managed: true, vendor: 'jbr'`인 JBR을 표시하고 `hotswapAgent: { installed, version? }`를 제공한다.
- **codex-5: main 연결**
  - 구성 필드 `hotReload` 저장·검사, JVM 인자 넣기, 감시·컴파일·적용, DevTools 판단, 상태 이벤트, `run_*` 확장.
- **claude-1: 화면**
  - 구성 창의 `바로 반영` 선택(끄기·표준·확장, Spring Boot 후보에서만 고를 수 있음, 확장은 JBR·HotswapAgent 가 없으면 받기 안내), 카드 줄의 반영 상태 칩, `재기동 필요` 때 재기동 버튼 강조.

```ts
type Preset = { /* 1단계 필드 */ hotReload: 'off' | 'standard' | 'enhanced' }
type RunState = { /* 1단계 필드 */ reload?: {
  status: 'watching' | 'compiling' | 'applied' | 'restartNeeded' | 'compileError' | 'failed'
  classes?: number   // applied: 바꾼 클래스 수 (아직 적재 안 된 것 포함)
  reason?: string    // restartNeeded·compileError·failed: 한 줄 이유 (포트·경로 없이)
  devtools?: true    // DevTools 가 다시 시작하는 방식
  at: number } }
```
- `run_list` 의 각 구성에 `reload` 를 더한다. `run_log` 는 맨 앞에 최근 반영 결과 10개를 `HH:MM:SS 바로 반영됨 · 클래스 3개` / `HH:MM:SS 재기동 필요: 메서드 추가 (com.example.Foo)` 꼴로 보인다.
- `run_wait(name, seconds, { until: 'reload' })`: 부른 뒤에 처음 나오는 반영 결과(`applied`·`restartNeeded`·`compileError`·`failed`)를 기다린다. 기본 `until` 은 지금처럼 시작 완료.
- 새 IPC 채널은 없다. 화면은 `run-preset-state` 의 `state.reload` 로 그린다.

## 진행
- [x] 1단계 설계 확정 (이 문서)
- [x] 1단계 main: 구성 저장·검사, 오류·시작 판정, `run_*` MCP 도구, 워크트리별 실행 (리뷰에서 바꿈: 실행 폴더는 부른 쪽 워크트리)
- [x] 1단계 화면: 카드 버튼, 구성 창, 전용 명령 확인 창(0.8초 무장), 알림, 첫 에이전트 조작 알림, 에이전트에게 보내기
- [x] 1단계 JDK 보관함 (6·7 은 무료 배포 없음 → 찾은 것 또는 JDK 8)
- [ ] 사용자 PC 확인: 실제 JDK 받기(Temurin 17·21, Zulu 8), 실제 Spring Boot·Vue 프로젝트로 구성 추가·재기동·멈춤 알림, 에이전트 run_restart
- [ ] 2단계
- [x] 3단계 표준 등급: JDWP 클라이언트, 감시·javac·반영, 잠금 중 연결 유지, `run_*` 의 `reload` (실제 확인: Zulu 17 + Maven 3.9.9 + Spring Boot 3.3.4 에서 HTTP 11→22 재기동 없음, 메서드 추가는 재기동 필요)
- [x] 3단계 확장 등급: JBR SDK 17·21 + HotswapAgent 2.0.5 받기와 실행 인자 (실제 확인: 작은 Java 프로그램에서 메서드 추가 호출까지)
- [x] 3단계 화면: 구성 창 `바로 반영`, 카드의 반영 상태 줄
- [ ] 3단계 사용자 PC 확인: 실제 프로젝트에서 바로 반영 켜고 저장, 확장 등급 받기와 Spring 빈 다시 읽기, DevTools 프로젝트 (실제 DevTools 확인은 오프라인 의존성 부족으로 못 함)
