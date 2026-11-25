# 개발 모드의 xterm dimensions 예외와 Codex Running hook

2026-11-25 조사. Windows의 ezShell 2.34.0 개발 빌드와 Codex CLI 0.172.0에서 확인했다.

## Codex Running hook

- **재현**. 임시 Codex 프로필에서 ezShell이 넣는 훅을 신뢰한 뒤 실제 Windows CLI에 루프백 모의 모델 응답과 named pipe를 연결한다. 짧은 차례를 끝내고 `agent-event`와 `stop-check`를 기록한다.
- **정상 응답**. `{"decision":"block","reason":PROMPT}`를 반환하면 CLI가 `Blocked by hook`을 표시하고 그 reason으로 차례를 이어 간다. 다음 Stop에서 `stop_hook_active=true`가 왔다. 0.172.0의 응답 형식이 ezShell 구현과 일치했다. [리포터](../../src/agentHookReport.js) · [Codex Stop 훅 문서](https://learn.chatgpt.com/docs/hooks#stop)
- **지연 재현**. `agent-event`에 응답하고 `stop-check`만 무응답으로 두면 리포터가 시작 후 1,507ms에 파이프를 닫고 CLI는 약 2초의 `Running hook` 표시 뒤 차례를 마친다. 12초 대기하는 훅 자식으로 바꾸면 Codex가 `hook timed out after 5s`를 표시하고 돌아온다. Stop 제한은 5초이고, SessionEnd와 Interrupt 제한은 3초다. `prepareStopWake`의 15초 타이머는 후속 읽음·도구 신호를 확인한다. [훅 설정](../../src/ipc/codexHookLaunch.js) · [Stop 알림 확인](../../src/ipc/agentInboxWake.js)
- **결론**. 원래 보고된 장시간 정체와 그 세션의 MCP 메시지 회수·답장은 확인하지 못했다. 프로토콜, 시간 제한, 진단 로그를 현 상태로 유지한다. 다시 발생하면 `/hooks`의 실행 항목을 확인하고 CLI의 훅 시작·종료 시각을 먼저 대조한다.

## 새 로컬 탭의 xterm dimensions 예외

- **재현**. 빌드 뒤 개발 렌더러를 임시 Electron 프로필로 띄워 일반 로컬 탭을 셋 연다. `electron-vite dev --rendererOnly -- --user-data-dir=<임시 폴더>`처럼 프로필을 넘긴다. `--rendererOnly`도 Electron을 띄운다. 에이전트와 사용량 줄이 없는 탭에서도 탭당 2건, 총 6건이 발생했고 같은 순서의 프로덕션 빌드는 0건이었다.
- **원인**. `Uncaught TypeError: Cannot read properties of undefined (reading 'dimensions')`가 `RenderService.dimensions`에서 났다. React 개발 모드의 `StrictMode`가 효과를 설치·정리·재설치하면서 첫 터미널을 해제한다. xterm 5.3.0이 예약한 `Viewport.syncScrollArea`의 타이머와 `Viewport._innerRefresh`의 프레임 콜백은 그 뒤에 실행된다. 단독 xterm에서도 같은 태스크에서 `open → dispose → open`을 하면 재현됐다. `visibility: hidden`과 크기 0에서의 `fit()`은 단독 시험에서 재현되지 않았다. [React 진입점](../../src/renderer/main.tsx) · [로컬 터미널 생명주기](../../src/renderer/components/Terminal/LocalTerminalTab.tsx)
- **결론**. 격리 사본에서 xterm 초기화를 취소 가능한 마이크로태스크로 옮겨 6건을 0건으로 줄였다. 개발 실행에서만 재현됐고 터미널 연결 시점과 `attach` 응답 순서에 영향을 줄 수 있어, 현재 초기화 순서와 `StrictMode`를 유지한다.
