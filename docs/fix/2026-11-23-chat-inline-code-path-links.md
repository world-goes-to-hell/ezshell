# 채팅 답변의 `코드` 로 적힌 파일 경로를 열 수 없음

2026-11-23 사용자 보고: Claude 가 "파일 위치: `D:\DEV\...\rsrc-mng-role-existing-emp.sql`" 처럼 경로를 인라인 코드로 적었는데, 채팅에서 눌러도 아무 일이 없었다.

## 원인
- 채팅은 마크다운 링크(`[이름](경로)`)와 웹 주소만 링크로 그렸다. Claude 는 경로를 링크보다 인라인 코드로 더 자주 적는다.
- main 의 "대화에 나온 링크" 목록(`links.js` 의 `linkKeysIn`)도 인라인 코드를 보지 않았다. 그래서 화면에서 링크로 그려도 main 이 열기를 거부했을 것이다.

## 수정
- 화면(`lib/markdownRender.ts`): 채팅용 변환기의 `code_inline` 규칙이, 내용이 경로이면 `<a class="md-code-link"><code>…</code></a>` 로 감싼다. 누르면 기존 링크와 같은 메뉴(ezShell 에서 열기·파일 탐색기에서 열기·경로 복사)가 뜬다. 링크 안의 코드는 다시 감싸지 않는다.
- main(`src/agentChat/links.js`): 같은 규칙(`CODE_PATH`)으로 인라인 코드의 경로를 대화의 링크로 센다. 두 파일의 정규식은 같게 유지해야 한다.
- 경로로 보는 것: 드라이브 경로(`D:\…`, 공백 허용), 둘 이상의 단계가 있는 `/…` 경로, 폴더가 있고 확장자가 있는 파일 이름(`src/a.js:12` 처럼 줄 번호 포함)이나 `/` 로 끝나는 폴더(`docs/plan/`). 상대 경로는 기존처럼 에이전트의 작업 폴더 기준이다.
- 경로로 보지 않는 것: `role_sn`, `/compact`, `feat/branch`(확장자 없음), 폴더 없는 파일 이름(`rsrc-mng-role.sql`), `\\host\share`. 폴더 없는 파일 이름은 작업 폴더에 없는 경우가 많아, 링크로 그리면 대부분 "찾지 못함" 이 된다.

## 이어서: 폴더 링크 (같은 날 사용자 보고)
- `mockups/` 같은 폴더 링크에서 `ezShell 에서 열기` 를 누르면 "폴더는 파일 탐색기에서 열어 주세요" 오류가 떴다. ezShell 에는 폴더를 여는 창이 없다.
- 이제 main(`ipc.js` 의 `openTarget`)이 폴더면 파일 탐색기에서 그 폴더를 연다 (`links.openFolder`). `shell.openPath` 는 파일이면 실행하므로, `main.js` 가 열기 직전에 폴더인지 한 번 더 확인한다.
- `/` 로 끝나는 링크는 메뉴가 `폴더 열기`·`경로 복사` 두 개다. 끝에 `/` 가 없는 폴더 경로는 메뉴가 그대로이고, `ezShell 에서 열기` 를 누르면 폴더가 열린다.
- 단위 테스트: `ipc.test.js` 의 "opening a link of an answer".

## 확인
- 단위 테스트: `links.test.js`, `markdownRender.test.ts` 에 인라인 코드 경로 확인을 더했다.
- 화면 테스트 `local-agent-chat`: 인라인 코드 경로가 링크로 보이고 main 이 열어 주는 것을 확인했다.
