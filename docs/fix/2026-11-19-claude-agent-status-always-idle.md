# Claude 에이전트 상태가 늘 "대기"로 나오던 문제 (2026-11-19)

## 증상

로컬 터미널에서 Claude Code 가 일하는 중인데도 사이드바 에이전트 칩과 칸 배치 그림의 상태가 "대기"였다. 같은 이유로 작업 중인 Claude 의 입력칸에 쉴 때용 메시지 알림("New ezShell message: …")이 들어갔다 (`agentInboxWake` 가 `isWorking`·`isRunningTask` 로 이 판정을 본다).

## 원인

실제 CLI 를 pty 로 띄워 터미널 제목·상태 신호를 기록했다.

- Claude Code: 일하는 동안 제목에 `◐ <작업>` / `◑ <작업>`(U+25D0·25D1)이 번갈아 돌고, 쉴 때는 `✳ <작업>`. 앱의 상태 질의(OSC 7501 `?`)에 답해도 상태 보고(OSC 7501 `state=`)를 보내지 않는다.
- Codex: OSC 7501 `state=working` / `state=done` 과 점자 스피너 제목을 보낸다 (문제없음).

앱의 제목 판정(`src/localShell.js` 의 `trackAgentActivity`)은 점자 스피너(U+2801–28FF)만 작업 중으로 봐서, Claude 의 반원 스피너가 돌아도 `idle` 이었다. Claude 는 상태 보고도 없으므로 제목이 유일한 근거였다.

## 수정

`WORKING_TITLE` 에 반원·4분원 스피너(U+25D0–25D3, U+25F4–25F7)를 더했다. 실제 기록 순서로 된 테스트를 `localShell.test.js` 에 넣었다 (고치기 전에 실패하는 것을 확인).

## 확인

단위 테스트, 화면 테스트 `local-agent-messages`(작업 중 알림 포함), `local-split` 통과.

## 다음에 볼 것

CLI 가 제목 모양을 또 바꾸면 같은 일이 생긴다. 의심되면 CLI 를 pty 로 띄워 OSC 0/2/9/7501 을 기록해 본다 (이번에 쓴 방법: node-pty 로 `claude` 를 빈 임시 폴더에서 실행, 상태 질의에는 앱과 같은 답을 보내고, 신뢰 질문은 아래 화살표로 Yes 를 고른다. 사용자의 전역 MCP 가 실행 중인 앱에 붙지 않도록 `--strict-mcp-config`, Claude Code 세션 안에서 실행한다면 `CLAUDE*` 환경 변수를 뺀다).
