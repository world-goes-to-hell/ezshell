# 원격 접속 3단계: 휴대폰에서 PC 탭 이어 보기와 에이전트

작성: 2026-11-24. 사용자 결정: 모바일에 안 된 것을 작업한다. 범위는 "에이전트까지" (에이전트 목록·채팅 읽기·글 보내기·확인 질문 답하기). 이전 단계: `docs/plan/2026-11-13-remote-access-over-tailscale.md`.

## 범위
1. **PC 탭 이어 보기 (SSH):** 휴대폰에서 PC 에 열려 있는 SSH 탭 목록을 보고, 고른 탭의 주 터미널을 이어 본다. 최근 출력부터 보이고 이후 출력이 실시간으로 이어진다. 저장 세션 탭에는 휴대폰에서 입력할 수 있고, 빠른 연결은 보기만 된다. PC 의 크기로 그리고 가로로 스크롤한다. 분할 칸·로컬 터미널 탭은 이어 보지 않는다.
2. **에이전트:** PC 로컬 셸에서 도는 Claude Code·Codex 목록(이름·역할·종류·상태·폴더 이름·확인 대기 여부). 고르면 채팅 화면: PC 채팅 보기와 같은 항목(말풍선·도구·생각·출력)을 읽고, 위로 올려 앞부분을 더 읽고, 글을 보내고, 작업을 중지하고(Esc), 확인 질문(번호 선택지)에 답한다.

## 보안 (바꾸면 안 되는 것)
- `휴대폰에서 PC 탭 이어 보기`는 기본 꺼짐(`remote-access.json`의 `tabs`)이다. 빠른 연결 탭은 `inputAllowed: false`다. 휴대폰은 탭 크기를 바꾸거나 xterm의 자동 응답을 PC에 보내지 않는다. 탭의 최근 출력은 메모리에 탭당 최대 256×1024자만 보관하고, 잠금이나 설정 끄기 때 지운다.
- 설정 > 원격 접속에 `휴대폰에서 에이전트 쓰기`(기본 꺼짐, `remote-access.json` 의 `agents`). 꺼져 있으면 에이전트 메시지를 모두 거부하고 `ready.features.agents` 가 false.
- 휴대폰은 로컬 셸에 글자를 직접 넣지 못한다. 글은 PC 채팅 보내기와 같은 `chatSend` 경로로만 간다 (확인 질문이 없고 입력칸이 비었을 때, 붙여 넣은 글을 확인한 뒤 Enter 한 번. PC 처럼 에이전트가 작업 중이어도 보낸다: CLI 가 다음 차례에 읽는다). 휴대폰에서는 슬래시 명령(`/…`)과 `!` 로 시작하는 글(Claude 의 셸 모드)을 거부한다. 이미지·첨부·링크 열기·띄워 두기·새 셸 열기는 없다.
- 확인 질문 답은 PC 와 같은 `answerApproval(id, key, signature)` 이고, 서버는 그 기기에 그 질문을 보낸 뒤 0.8초가 지나야 받는다 (화면도 같은 규칙). 현재 질문의 선택지를 다시 확인하고 `계속 허용` 같은 지속 권한은 거부한다.
- `remote-access.log`에 `chat-send`·`chat-answer`·`chat-interrupt`·`tab-attach`·`tab-input`의 기기와 대상(에이전트 id·탭 이름)을 남긴다. 채팅 동작은 결과(`ok`), 글 보내기는 글자 수(`chars`)를 더 기록한다. 보낸 글·입력은 남기지 않는다.
- 셸 id·탭 id 는 서버가 지금 목록에 있는지 다시 본다. 에이전트나 확인된 `sessionId`가 바뀌거나 사라지면 새 프레임을 보내기 전에 구독을 닫는다. 앱을 잠그면 기존처럼 모두 끊는다.
- PC 탭 출력이 2MiB 넘게 밀리면 해당 탭의 이어 보기를 끊는다. 다음 메시지를 포함한 기기별 전송 대기량이 4MiB를 넘으면 그 기기의 연결을 닫는다.

## 프로토콜 (WebSocket JSON, 기존 메시지는 그대로)
서버 → 휴대폰
- `ready`에 추가되는 필드는 `features: { tabs: boolean, agents: boolean }`과 `theme`이다. 설정이 바뀌면 `features` `{ features }`, 본창 테마가 바뀌면 `theme` `{ theme }`이 온다. 테마는 `captureThemeTokens`로 검사한 값만(`controller.js`의 `remoteThemeOf`), 빠진 값은 휴대폰의 CSS 기본값을 쓴다.
- `tabs` `{ tabs: [{ id, name, folder, color, connected, inputAllowed }], error? }` (`tabs-list`의 답, PC에서 연 순서. `folder`·`color`는 없으면 `null`, 설정이 꺼져 있으면 목록은 비어 있고 `error`가 온다.)
- `tab-attached` `{ tabId, cols, rows, snapshot, inputAllowed }` (snapshot은 그 탭 주 터미널의 최근 출력이며 터미널 제어 문자를 포함한다.)
- `tab-data` `{ tabId, data }` (20ms 묶음), `tab-ended` `{ tabId, reason: 'closed'|'disconnected' }`, `tab-error` `{ tabId, message }`
- `agents` `{ agents: [{ shellId, agentId, kind, name, role, status, folderName, waitingApproval }], error? }` (`agents-list`의 답, `agents-watch`를 켠 동안 바뀔 때마다. `agentId`·`role`·`folderName`은 없으면 `null`, 설정이 꺼져 있으면 목록은 비어 있고 `error`가 온다.)
- `chat-frame` `{ shellId, ...PC 의 agent-chat-frame 필드 }` (그 채팅을 연 기기에만)
- `chat-opened` `{ shellId, ok, error? }` (에이전트가 바뀌어 구독을 닫을 때도 `ok: false`와 이유를 보낸다), `chat-older-result` `{ shellId, ok, error? }`
- `chat-send-result` `{ shellId, requestId, ok, reason?, error? }`
- `chat-answer-result` `{ shellId, ok, error? }`, `chat-interrupt-result` `{ shellId, ok, error? }`
휴대폰 → 서버
- `tabs-list` `{}`, `tab-attach` `{ tabId }`, `tab-input` `{ tabId, data }`, `tab-detach` `{ tabId }`
- `agents-list` `{}`, `agents-watch` `{ on }`
- `chat-open` `{ shellId }`, `chat-older` `{ shellId }`, `chat-close` `{ shellId }`
- `chat-send` `{ shellId, requestId, text }` (text 16,000자까지)
- `chat-answer` `{ shellId, key: '1'~'9', signature }`, `chat-interrupt` `{ shellId }`
정적 파일 추가: `/tabs.js`, `/agents.js`, `/agents.css`.
- 합의 (codex-7 확인): PC 의 `agent-chat-frame.status` 는 Claude·Codex 에서 null 이라, 휴대폰은 작업 상태·`중지` 를 `agents` 의 `status` 로 판단한다. 그래서 `agents-watch` 는 목록과 채팅을 한 묶음으로 켜 두고, app.js 는 목록↔채팅 사이에서는 `enter()`/`leave()` 를 부르지 않는다 (다른 탭으로 나갈 때만 `leave()`). 서버는 상태가 바뀔 때마다 `agents` 를 보낸다. `chat-older-result` 는 그 요청으로 읽은 앞부분의 `chat-frame` 뒤에 보낸다.

- 서버 구현에서 정한 것 (claude-4): 설정이 꺼져 있으면 `agents-list` 에 `{ type: 'agents', agents: [], error }`, 설정을 끄면 접속한 기기에 같은 메시지와 채팅 닫힘. PC 에서 설정을 바꾸면 `features` `{ features }`. `tabs` 는 탭을 연 순서(main 은 PC 탭 줄 순서를 모름), 빠른 연결 탭 이름은 `빠른 연결`(주소가 섞일 수 있어). 휴대폰이 2MB 넘게 밀리면 `tab-error` 후 이어 보기를 뗀다(PC 셸은 멈출 수 없음). `tab-ended` `disconnected` 는 끊김·재연결 시작 때, 재연결 뒤 같은 `tabId` 로 다시 붙는다. `tab-input` 기록은 이어 보기마다 처음 한 번과 1분에 한 번. `status` 는 localShell 값 그대로, `waitingApproval` 은 blocked 이거나 화면에 번호 질문이 있을 때. 휴대폰 채팅은 모든 기기를 합쳐 8개까지(`chats.js` 의 보는 쪽 키: 셸+기기, PC 보기는 다시 시작하지 않음).

## 나눠서 작업 (같은 폴더의 main 에서 동시에 일한다: 남의 파일은 건드리지 않는다)
- **claude-4 (main·서버):** `src/remoteAccess/server.js`·`controller.js`, 새 모듈 `src/remoteAccess/tabMirror.js`·`agentBridge.js`, `src/ipc/sshSessions.js`(탭 출력 보관·크기 기록만), `src/agentChat/chats.js`(채팅을 PC 창과 휴대폰이 함께 볼 수 있게: 보는 쪽 여럿), `main.js` 연결, 설정 화면의 켜기 칸(`RemoteAccessSettings.tsx`), 단위 테스트.
- **codex-6 (휴대폰 화면, 탭과 뼈대):** `src/remoteAccess/web/app.js`·`index.html`·`app.css`, 새 `web/tabs.js`. 아래 하단 탭 줄에 `PC 탭`·`에이전트` 를 더하고, `view-agents`·`view-chat` 자리와 `agents.js`·`agents.css` 태그를 넣고, `agents`·`chat-*` 메시지를 `ezRemote.createAgents` 가 만든 객체로 넘긴다.
- **codex-7 (휴대폰 화면, 에이전트):** 새 `web/agents.js`·`web/agents.css` 만. `window.ezRemote.createAgents({ list, chat, send, show })` 가 `{ enter(), leave(), reset(), onMessage(msg) }` 를 돌려준다 (`list`·`chat` 은 `view-agents`·`view-chat` 의 요소, `show(name)` 은 화면 전환).
- **claude-5 (조율):** 이 문서·CLAUDE.md, PC 확인 창의 "휴대폰 응답 대기 중" 표시, 통합 확인(실제 앱 + 390px 화면), 보안 검토.
- 휴대폰 화면 담당은 서버가 끝나기 전에 흉내 서버(스크래치 스크립트)로 390px 화면에서 확인한다. 테스트는 각자 바꾼 것만 (`vitest related`, CLAUDE.md 의 테스트 범위 절).

## 진행
- [x] 서버: 탭 목록·이어 보기 (claude-4, `tabMirror.js`, `sshSessions.js` 출력 기록)
- [x] 서버: 에이전트 목록·채팅·보내기·답하기·중지, 설정 켜기 칸 (claude-4, `agentBridge.js`, `chats.js` 보는 쪽 여럿, `accessStore.js` 의 `agents`. vitest related 179개, typecheck, build, e2e `shortcuts` 통과)
- [x] 실서버 통합. 실제 `server.js`·`tabMirror.js`·`agentBridge.js`와 시험용 탭·에이전트를 연결해 기기 등록·TOTP부터 390px 브라우저에서 확인했다. 캡처 `e2e/.out/remote-access-live-*-390.png`, 보안·테마 반영 뒤 캡처 `remote-access-security-*-390.png`·`remote-access-theme-*-390.png` (codex-6).
- [x] 보안 검토 반영 (CRITICAL 없음, HIGH 2). 탭 이어 보기의 기본 꺼짐·빠른 연결 보기만·`tab-attach` 기록, PC 명령 실행 안내·지속 권한 선택 거부·보낸 글자 수 기록, 잠금 시 출력 삭제·전송 밀림 한도·휴대폰 xterm 입력 허용 목록을 반영했다 (서버 claude-4·codex-7, 화면 codex-6).
- [x] 에이전트 교체 시 옛 구독 정리. `agentBridge.js`에서 후속 프레임마다 에이전트와 확인된 대화가 같은지 확인하고, 달라지면 닫는다. 작업 중 보내기는 PC와 같은 경로로 허용한다 (codex-7).
- [x] 휴대폰 화면이 사용자의 ezShell 테마를 따름 (2026-11-24 사용자 요청). 동일한 캡처 테마 검사로 만든 `ready.theme`·`theme`을 받고 CSS 변수와 열린 xterm에 반영한다. 밝은·어두운 테마 전환과 기본값 복원을 390px 브라우저에서 확인했다 (서버 codex-7, 화면 codex-6).
- 담당 변경 (사용자 지시: Claude 사용량을 아끼려고 Codex 로 옮김): claude-4 의 남은 서버 작업은 codex-7 이 인계받는다. claude-5 는 조율만.
- [x] 서버 변경 관련 단위 테스트 254개와 화면 테스트 `local-agent-chat`·`shortcuts` 통과 (codex-7). 앞서 실패한 `Codex lists its question outside the virtual viewport` 검사도 이후 `local-agent-chat` 실행에서 통과했다.
- [x] 휴대폰: 탭 목록·이어 보기, 하단 탭 줄과 뼈대 (codex-6, `web/app.js`·`index.html`·`app.css`·`tabs.js`).
- [x] 휴대폰: 에이전트 목록·채팅 화면 (codex-7, `web/agents.js`·`agents.css`, 테마 색·모서리·글꼴은 codex-6).
- [x] PC 확인 창에 `휴대폰에도 보냄` 표시 (claude-5). main의 `showMcpApproval`이 PC 창 사본에만 `sentToPhone`을 붙인다 (`remoteAccess.approvalWaitMs() > 0`). 타입 검사 통과. 표지가 뜨는 PC 화면은 미확인.
- [x] `CLAUDE.md`에 3단계와 로컬 셸·작업 공간 기록·원격 채팅의 범위를 정리했다 (codex-6).
