# 실행 구성 서버가 업데이트를 거쳐도 유지되게 하기

상태: 완료 (2026-11-27). 실제 Spring Boot·Tomcat 으로 업데이트를 거치는 확인은 아직 하지 않았다 (화면 시험은 node 서버로 확인).
요청: 2026-11-27 사용자. "업데이트 받을 때 로컬 java 서버가 유지되도록 바꿔줘"
범위: Windows (세션 보관 프로세스가 있는 플랫폼). macOS·Linux 는 지금처럼 종료한다.

## 지금 동작과 원인

- 로컬 터미널 셸은 업데이트 재시작 때 세션 보관 프로세스(`src/sessionHost/host.js`)가 3분 붙잡고, 새 앱이 `adopt` 로 넘겨받는다.
- 실행 구성은 `localShell.js` 의 `launchDevelopment` → `launchProcess` 가 node-pty 로 **앱 안에서** 띄운다 (`spawn`, host 아님).
- 종료 순서: `before-quit` 가 `drainDevelopmentTasks()` 로 모든 실행을 끝내고(`taskkill /T /F`), 각 실행의 `cleanup` 이 Tomcat 실행 폴더 등을 지운다. 그 뒤 `finishSessionQuit` 의 `handOver()` 는 host 셸만 넘긴다.

## 설계

### 1. 서버 단계 PTY 를 세션 보관 프로세스에서 연다

- `launchProcess(…, 'server')` 는 host 가 준비되어 있으면 `host.spawn` 으로 연다. 준비 단계(빌드 PTY, main 의 javac·이클립스식 빌드)는 지금처럼 앱 안에서 연다. 짧고, main 안의 작업은 넘길 수 없다.
- host 의 PTY 는 `spawned` 응답이 와야 `pid` 가 정해진다. `launched` 이벤트(바로 반영의 JDWP 리스너 소유 확인, 헬스 확인이 pid 를 쓴다)는 pid 를 받은 뒤에 낸다.
- 일반 종료는 지금과 같다: `drainDevelopmentTasks` 가 pid 로 프로세스 트리를 끝내고 `cleanup` 을 기다린다.

### 2. 업데이트로 끝날 때: 서버 단계 실행은 넘기고 나머지만 끝낸다

- 업데이트 재시작은 창을 닫기 전에 `keepSessionsForUpdate`(host 에 keep)를 이미 보낸다. keep 이 확인되면 `before-quit` 의 정리는 **host 에 있고 서버 단계인 실행**을 건너뛴다. 준비 중이던 실행, 기동 순서(배치)는 지금처럼 끝낸다.
- 넘기는 실행은 `cleanup` 을 부르지 않는다 (Tomcat 실행 폴더가 지워지면 서버가 깨진다). 대신 `handOver` 가 host 메타에 실행 정보를 적는다.
  - 실행: 프로젝트 루트·워크트리, 구성 id, 표시 이름, 상태(`running`·`starting`), `startedAt`, `readyAt`, 주소, 로그 인코딩
  - 바로 반영: JDWP 포트, 모드, 실행 폴더, Tomcat 배치 정보 (새 앱이 다시 연결하고 출력에서 포트를 가린다)
  - 정리 대상: 이 실행이 만든 임시 폴더 경로(Tomcat base, 이클립스식 클래스 폴더, Maven 설정 파일 폴더, Maven 고정 실행 폴더)

### 3. 새 앱이 넘겨받는다

- `localShells.adopt` 가 메타에 실행 정보가 있는 셸을 개발 실행 항목으로 되살린다 (같은 `local:N` id, 출력 보관분, `exited: false`).
- `runPresets.adoptRun` 이 실행을 다시 잇는다. 메타는 데이터로만 다루고 모두 다시 검증한다.
  - 저장된 구성 중 같은 id 가 그 프로젝트·워크트리에 있고 실행 폴더가 그 워크트리 안의 실제 경로인지 확인한다. 맞지 않으면 (구성을 지웠거나 옮김) 그 프로세스 트리를 끝낸다. 주인 없는 서버를 남기지 않는다.
  - 상태·주소·`readyAt` 을 메타로 복원하고, 보관된 출력을 오류 분석기에 다시 넣어 오류 묶음을 만든다.
  - 바로 반영이 켜진 실행은 같은 포트로 JDWP 에 다시 붙는다. 기존의 "리스너가 그 실행의 프로세스 트리 소유인지" 확인을 그대로 거친다.
  - `cleanup` 을 정리 대상 경로로 다시 만든다. 경로는 앱 소유 폴더 안의 정해진 이름 패턴만 받는다 (`runScratch.js` 의 패턴과 같은 검사).
- 화면: 실행 카드는 잠금 해제 뒤 받는 실행 상태로 `실행 중` 을 보이고, 열어 둔 로그 탭은 기존 칸 배치 복원(`local-shell-kept-layout`)으로 돌아온다.

### 4. 시작할 때의 임시 폴더 회수가 살아 있는 서버의 폴더를 지우지 않게

- 지금 `reapRunScratch` 는 앱 시작 직후 "이름에 든 PID 가 끝난" 폴더를 지운다. Tomcat base 이름은 **앱의 PID**(`run-<앱 PID>-…`)라서, 업데이트 뒤 새 앱이 넘겨받은 Tomcat 의 실행 폴더를 지운다.
- 회수는 세션 보관 프로세스 재연결이 끝난 뒤에 돌리고, 넘겨받은 실행의 정리 대상 경로는 건너뛴다.

## 넘기지 않는 것 (알려 둘 한계)

- 준비 단계(빌드) 중이던 실행: 끝나고, 새 앱에서 다시 실행해야 한다.
- Maven 고정(`mavenPin`)의 보관: 넘겨받은 실행이 끝날 때는 새 보관본을 만들지 않고 이전 보관본을 유지한다 (보관에 필요한 Resolver 기록이 옛 앱의 메모리에 있다).
- 업데이트 설치가 3분을 넘기면 host 가 서버를 끝낸다 (로컬 셸과 같은 규칙). 남은 임시 폴더는 다음 시작에서 회수한다.

## 바꿀 파일

- `src/localShell.js`: 서버 단계 host 실행, pid 대기, 업데이트 정리에서 넘길 실행 제외, `handOver` 메타, `adopt` 의 개발 실행 복원
- `src/ipc/runPresets.js`: `adoptRun`, 메타 검증, 상태·로그 복원, 바로 반영 재연결
- `src/ipc/hotReload.js`·`tomcatRun.js`: 넘길 정보 꺼내기와 정리 다시 만들기
- `src/ipc/runScratch.js`: 제외 경로
- `main.js`: 업데이트 여부에 따른 `before-quit` 정리, 회수 시점, 넘겨받은 실행 연결
- 문서: `docs/architecture/local-project-run.md`, `app-updates.md`

## 검증

- 단위: 서버 단계가 host 로 열림 / 업데이트 정리에서 제외·메타 기록 / adopt 복원과 검증 실패 시 종료 / 회수 제외 / 정리 재구성
- 화면 시험 `local-keep-through-update` 에 실행 구성 하나(이 PC 에서 응답하는 작은 HTTP 서버)를 더해, 업데이트 재시작 뒤 같은 PID 로 살아 있고 카드가 `실행 중`이며 그 뒤 중지가 동작하는지 확인
- 실제 Spring Boot(Gradle)·Tomcat 실행 하나씩을 dev 빌드에서 업데이트 시험 모드로 확인
