# 진단 정보 (오류 기록·진단 묶음·바로작업 상태 첨부)

2026-11-28 사용자 요청: 개선 제안 3번. 1번(에이전트별 수정 파일) 다음. 개발E(claude-8) main, 개발A(claude-2) 화면.

## 문제

- main 에서 잡히지 않은 오류가 어디에도 남지 않는다 (`main.js`·`src/` 에 `uncaughtException`·`unhandledRejection` 처리 없음).
- 버그를 알릴 때 버전, CLI 버전, 에이전트 상태를 사람이 따로 모아야 한다. 바로작업 캡처로 ezShell 버그를 보낼 때도 받는 에이전트가 그 상태를 모른다.

## 정하는 것

1. 오류 기록 (main, `src/ipc/errorLog.js`): `userData/logs/errors.log` 에 한 줄 JSON 으로 남긴다. 1MB 를 넘으면 `errors.1.log` 로 밀어낸다. 1분에 50건까지.
   - 받는 것: main 의 잡히지 않은 예외(`uncaughtExceptionMonitor`), 처리되지 않은 Promise 거부(`warning` 이벤트의 `UnhandledPromiseRejectionWarning`), 창 프로세스·보조 프로세스가 죽은 것(`render-process-gone`·`child-process-gone`, 정상 종료 제외), 본창 콘솔의 오류.
   - 바꾸면 안 되는 것: 앱의 동작을 바꾸지 않는다. `uncaughtException`·`unhandledRejection` 에 듣는 함수를 달면 Node 의 기본 처리가 바뀌므로 `uncaughtExceptionMonitor` 와 `warning` 만 쓴다. 실측(2026-11-28, Electron 45): main 의 거부는 앱을 끝내지 않고 경고 둘(`Error: …` 와 안내 문장)을 낸다. 예외도 앱을 끝내지 않는다.
   - 브라우저 탭의 웹 페이지 콘솔은 담지 않는다 (남의 사이트 내용).
2. 진단 묶음 (main, `src/ipc/diagnostics.js`): 사람이 읽는 한국어 텍스트. 앱·Electron·OS 버전, 메모리·가동 시간, Claude Code·Codex 버전, 에이전트 목록(id·종류·역할·상태·상태 출처·MCP 연결·잠듦, 메시지 내용 없음), Codex 훅 승인 상태, 로컬 셸 수, 최근 오류 50건.
   - 홈 폴더 경로는 `~` 로 바꾼다. 메시지·프롬프트·비밀 값은 담지 않는다.
3. 바로작업 상태 첨부 (main): 캡처한 영역이 ezShell 창과 겹치면, 에이전트에 보내는 요청 끝에 짧은 상태(앱·CLI 버전, 에이전트 상태, 최근 오류 5건 요약)를 붙인다. 다른 프로그램을 캡처하면 붙이지 않는다.

## IPC 계약 (개발E main ↔ 개발A 화면)

모두 본창 메인 프레임에서만 받는다. 잠금 중에도 된다 (잠금 화면 문제를 알릴 때도 필요. 담는 내용에 비밀이 없다). 단, 잠금 중에는 에이전트 목록을 빼고 만든다.

- `diagnosticsReport()` → invoke `diagnostics-report` → `{ success: true, text: string, errors: number }` (`errors` 는 최근 24시간 오류 수).
- `diagnosticsSave()` → invoke `diagnostics-save` → main 이 묶음을 새로 만들어 저장 대화 상자로 쓴다 → `{ success: true, path }` / `{ success: false, cancelled: true }` / `{ success: false, error }`. 화면이 준 글을 쓰지 않는다.
- `diagnosticsOpenLogs()` → invoke `diagnostics-open-logs` → 로그 폴더를 탐색기로 연다 → `{ success }`.
- 복사는 화면이 `diagnosticsReport().text` 를 클립보드에 넣는다.

## 화면 (개발A)

- 설정에 `진단 정보` 칸: 최근 오류 수, 미리보기(접힘), `복사`·`파일로 저장`·`로그 폴더 열기`.
- 명령 팔레트에 `진단 정보 복사`.
- 단위 테스트와 화면 테스트 명세 하나.
