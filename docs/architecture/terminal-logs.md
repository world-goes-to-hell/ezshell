# 터미널 로그 강조와 저장

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

## Terminal Log Highlight (오류·경고 줄 강조)

모든 터미널(탭의 주 터미널, 분할 셸, 로컬 터미널, 분리한 창)은 화면의 오류·경고 줄에 옅은 바탕색과 왼쪽 선을 그린다 (`Terminal/terminalLogHighlight.ts` 의 `attachLogHighlight`, 줄 판정은 `lib/terminalLogRows.ts`). `tail -f`, `docker logs -f` 같은 로그를 보기 위한 것이고 명령을 가리지 않고 모든 출력에 적용한다. 수준 규칙은 파일 실시간 보기와 같은 `lib/logLevels.ts` 의 `classifyLine` 이다. 우클릭 `편의` 의 `오류·경고 줄 강조 끄기/켜기`(`localStorage` 의 `terminalLogHighlight`, 기본 켜짐). 설계: `docs/plan/2026-11-17-terminal-log-highlight.md`.
- 화면에 보이는 줄만, 프레임당 한 번 읽는다. 서버에는 아무것도 보내지 않는다. 전체 화면 프로그램(vim, less)에서는 그리지 않는다.
- 너비에서 접힌 줄은 한 줄로 이어 판정한다. 커서가 있는 줄(입력 중)과 명령 줄은 뺀다 (`isCommandLine`). 바꾸면 안 되는 것: 명령 줄 판정에 `commandCapture` 의 프롬프트 규칙을 쓰지 말 것. 그 규칙은 `> ` 나 `% ` 가 있으면 모두 프롬프트로 봐서, 그런 글자가 든 로그 줄이 강조에서 빠진다.
- 바꾸면 안 되는 것: 줄의 꾸밈은 그 줄의 표식(marker)에 달고, 수준이 그대로인 줄은 다시 만들지 않는다. 프레임마다 지우고 새로 만들면 출력이 흐르는 동안 깜빡인다.

## Session Log (터미널 출력을 파일로 저장)

탭 우클릭 메뉴 또는 명령 팔레트의 `로그 저장 시작/중지` 로 켜고 끈다. 기록 중인 탭에는 붉은 점이 붙는다 (`.tab-log-indicator`).
- 파일: `문서\ezShell Logs\<세션 이름>_<YYYYMMDD-HHmmss>.log`. 이름은 `logFile.js` 의 `safeFileName` 이 경로 문자를 `_` 로 바꾸고, 파일은 `wx` 로 열어 덮어쓰지 않는다.
- main 프로세스가 기록한다 (`src/sessionLog/`). SSH 스트림의 data 이벤트에서 `sessionLogger.write` 를 부르고, 로그의 어떤 실패도 터미널로 가는 데이터를 막지 않는다.
- 터미널 해석은 `@xterm/headless` 에 맡기고 줄바꿈이 처리될 때 완성된 줄을 읽는다 (`lineRecorder.js`). 전체 화면 프로그램 구간은 표시 한 줄만 남긴다. 직접 만든 필터로 바꾸지 말 것: 너비를 넘는 명령줄과 두 칸 글자에서 깨진다 (`docs/brain/2026-10-02-xterm-headless-wide-char-wrap-padding.md`).
- 탭의 주 터미널만 기록한다 (탭 안 분할 셸 제외). 자동 재연결되면 같은 파일에 이어 쓰고, 탭을 닫거나 연결이 완전히 끊기면 끝낸다.
- 출력된 내용은 평문으로 남는다 (`cat .env` 의 결과도). 그래서 사용자가 켠 탭만 기록한다.
- `src/sessionLog` 는 번들되지 않고 `electron.vite.config.ts` 가 `out/main/src/sessionLog` 로 복사한다.
