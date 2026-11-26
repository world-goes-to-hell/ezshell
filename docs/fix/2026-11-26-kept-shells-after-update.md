# 업데이트 뒤 되살린 셸: 탭이 두 개씩, 채팅이 터미널로, 입력칸을 못 찾음

## 증상 (2026-11-26, 2.37.0 → 2.37.1 업데이트, 사용자 보고)

1. 업데이트 뒤 탭이 자동으로 돌아왔는데, 상단 안내 줄 `업데이트 전에 열려 있던 탭 N개를 다시 열까요?` 에서 다시 열기를 누르니 같은 세션이 두 개씩 생겼다.
2. 채팅 보기로 쓰던 칸이 터미널 보기로 돌아왔다.
3. 채팅에서 보내면 `에이전트의 입력칸을 찾지 못했습니다. 터미널 보기에서 확인해 주세요.` 로 실패했다. 쉬던 세션은 터미널을 한 번 보고 와야 동작했고, 작업 중이던 세션도 바로는 안 됐다.

## 원인

1·2. **창이 보관 프로세스보다 먼저 셸을 물었다.** 창은 첫 잠금 해제 뒤 `local-shell-list` 와 `local-shell-kept-layout` 을 한 번 묻는다(`lib/localShellAdopt.ts`). main 은 시작할 때 런타임 복사본을 준비한 뒤 보관 프로세스에 다시 붙고 셸을 되살리는데(`startSessionHost`), 두 IPC 는 그것을 기다리지 않았다. 자동 잠금 해제로 창이 먼저 물으면 빈 목록을 받고 배치는 소비된다. 그러면 되살린 셸이 탭으로 돌아오지 않고(배치가 없어 채팅 칸도 없음), 되살린 셸 목록(`keptLocalShells`)이 비어 안내 줄이 모든 탭을 새로 열었다. 새로 연 탭의 에이전트는 새 id 로 등록된다 (업데이트 전 claude-6·8 이 claude-9·10 으로 바뀌어 있었다).
3. **깨우기 화면이 비어서 시작했다.** 채팅 보내기는 main 이 따로 그리는 CLI 화면(`agentInboxWake` 의 headless xterm)에서 입력칸을 찾는다. `adopt()` 는 그 화면을 새로 만들지만 보관 프로세스가 넘긴 출력은 탭 화면에만 다시 그렸다. 쉬는 CLI 는 아무것도 다시 그리지 않고, 작업 중인 CLI 는 진행 줄만 고쳐 그려 입력칸이 화면에 생기지 않았다. 터미널을 보면 크기 조정으로 CLI 가 전체를 다시 그려 풀렸다.

화면 시험 `local-keep-through-update` 가 이것들을 잡지 못한 이유: 알림의 `재시작` 대신 `localShellKeepLayout`·`installUpdate` 를 직접 불러 복원 기록이 없었고(안내 줄 검사가 늘 통과), 새 앱이 늘 보관 프로세스를 먼저 찾았고, 에이전트가 없었다.

## 고친 것

- `main.js`: `sessionHostStarted()` 로 두 IPC 가 보관 프로세스 시작을 최대 15초 기다린다.
- `src/localShell.js` `adopt()`: 에이전트 셸의 깨우기 화면에 `backlog` 를 먼저 그린다.
- 시험: `local-keep-through-update` 가 알림의 `재시작` 버튼으로 실제 순서(`lib/updateInstall.ts`, 복원 기록 저장 포함)를 거치고, 새 앱은 보관 프로세스를 5초 늦게 찾는다(`EZSHELL_TEST_SESSION_HOST_DELAY_MS`, 패키징 앱은 무시). 시험용 재시작 모드에서 업데이트 확인은 곧바로 다운로드 완료를 알린다(`src/ipc/updates.js`). 고치기 전에는 `it is back in its tab`·`the restore notice does not offer the tab again` 이 실패했다 (안내 줄: `업데이트 전에 열려 있던 탭 1개를 다시 열까요?`).
- 단위 시험 `src/localShellHost.test.js`: 실제 CLI 화면 표본(`claude-100x24-idle`·`codex-100x24-idle`)을 보관 출력으로 두고 되살린 뒤 `chatSend` 가 바로 보내는지. 고치기 전에는 `{ ok: false, reason: 'no-composer' }`.

## 확인하지 못한 것

- 진짜 Claude·Codex 가 든 칸이 업데이트 뒤 채팅 보기로 돌아오는 것은 화면 시험에 없다 (보관 프로세스와 시험용 가짜 에이전트를 함께 쓸 수 없다). 배치가 넘어오면 `queueChatView` 가 넘겨받은 에이전트를 기다려 채팅으로 연다.
