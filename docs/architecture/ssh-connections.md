# SSH 연결과 복구

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

## SSH Data Flow

```
main.js (ssh2 shell) → IPC 'ssh-data' → terminalStore.dispatchSshData()
  → registered handler (per sessionId) → xterm.write()
```

Split 터미널은 별도 IPC 채널 사용: `ssh-split-data`, `ssh-split-send`

## SSH Channel Open Failure

분할 터미널 생성 시 이전 스트림이 완전히 닫히지 않으면 서버가 새 채널 거부.
- main.js `ssh-create-shell`에서 실패 시 해당 세션의 모든 stale split 스트림 자동 정리 후 재시도
- SplitTerminal에서 exponential backoff 자동 재시도 (최대 3회)

## Root Switch (로그인 후 su -)

세션 편집 > 고급 설정의 "로그인 후 root 로 전환"(`suRoot`, `suPassword`)을 켜면 셸이 열린 뒤 main 이 `su -` 를 보내고 비밀번호를 넣는다 (`src/rootSwitch.js` 의 `switchToRoot`). `ssh-connect` 는 전환이 끝난 뒤 답하므로 자동 실행 스크립트는 root 로 실행된다. 자동 재연결·재연결 버튼 뒤에도 다시 전환한다. 결과(`switched`/`failed`/`no-prompt`/`unknown`)만 렌더러로 가고 알림은 `lib/rootSwitch.ts`. 설계: `docs/plan/2026-11-04-su-root-switch.md` (MCP 의 root 실행은 2단계).
- 바꾸면 안 되는 것: 비밀번호는 출력 끝에 비밀번호 입력 문구(`Password:`/`암호:`/`비밀번호:`)가 보일 때만, 한 번만 보낸다. 10초 안에 문구가 없으면 보내지 않는다 (이미 root 이거나 su 가 묻지 않으면 비밀번호가 명령으로 실행·표시된다). 비밀번호를 보내기 전에는 `su:` 로 시작하는 줄만 실패로 본다 (로그인 안내문의 sorry 등을 실패로 오인하지 않게).
- 새 `src/*.js` 라서 `MAIN_RUNTIME_MODULES` 에 있다.

## SSH Algorithms (오래된 서버)

모든 ssh2 연결은 `src/sshAlgorithms.js` 의 `SSH_ALGORITHMS` 를 `algorithms` 로 넘긴다 (`main.js` 의 세 연결, `sshConnectionTest.js` 의 `buildOptions` → 연결 테스트·MCP). ssh2 기본값 뒤에 SHA-1 키 교환, CBC 암호, `ssh-dss`, `hmac-md5` 등을 `append` 로 붙여 PuTTY 로만 되던 오래된 서버에도 접속한다. 앞에 붙이거나 기본값을 바꾸지 말 것: 맨 뒤라서 새 방식을 아는 서버는 새 방식을 쓴다. 런타임이 지원하지 않는 이름은 빼고 붙인다 (ssh2 가 예외를 던짐). 새 `src/*.js` 라서 `MAIN_RUNTIME_MODULES` 에 있어야 한다. 설명: `docs/fix/2026-11-04-legacy-ssh-algorithms.md`.

## SSH Host Key Verification

모든 ssh2 연결(터미널, 점프 호스트, 자동 재연결, 연결 테스트, MCP)은 `hostVerifier` 로 서버의 호스트 키를 `userData/known-hosts.json` 과 비교한다 (`src/hostKeys/`). 설계와 보안 검토 반영: `docs/plan/2026-10-14-ssh-host-key-verification.md`.
- 처음 보는 서버나 바뀐 키는 연결을 바로 끊고 확인 창(`HostKeyDialog.tsx`)을 띄운 뒤, 신뢰하면 저장하고 처음부터 다시 접속한다. 핸드셰이크 중에 기다리면 readyTimeout 에 걸리기 때문이다.
- 묻는 곳은 터미널 연결과 연결 테스트뿐이다. 자동 재연결은 키가 다르면 재연결을 멈추고, MCP 는 저장된 키가 없거나 다르면 거부한다 (사람이 없을 수 있어서).
- MCP 로 가는 거부 문구에는 서버 주소를 넣지 않는다 (`hostKeyMessage(err, { subject })`, 게이트웨이는 "이 세션의 서버"/"이 세션의 점프 호스트"). 앱 화면 문구에만 주소가 들어간다.
- 바꾸면 안 되는 것: 렌더러는 요청 ID 와 결정만 보낸다 (`host-key-respond`). 저장하는 키는 main 이 거부할 때 붙잡아 둔 값이다. `createSessionGateway` 와 `testSshConnection` 은 저장소/검증 함수가 없으면 모든 키를 거부한다.
- 파일의 서버 주소는 HMAC 으로만 남긴다 (세션 파일은 암호화되어 있음). 파일을 읽지 못하면 저장하지 않는다 (덮어쓰면 저장된 키가 모두 사라져 "바뀜" 이 "처음 보는 서버" 로 보인다).
- `src/hostKeys` 는 번들되지 않고 `electron.vite.config.ts` 가 `out/main/src/hostKeys` 로 복사한다.

## Connection Lost Overlay (탭 연결 끊김)

탭의 연결이 끊기면(`TerminalInfo.connected: false`) 터미널 영역(분할 셸 포함)을 흐리게 하고 `ConnectionLostOverlay.tsx` 가 "연결 끊김" 과 `재연결` / `종료` 를 보여 준다. 문구는 `lib/connectionLost.ts`. 자동 재연결 중에는 시도 횟수(`TerminalInfo.reconnect`)를, 실패하면 이유(`disconnectNote`)를 보여 준다. 설계: `docs/plan/2026-10-27-terminal-connection-lost-overlay.md`.
- `재연결` 은 `ssh-reconnect-now` 로 탭을 처음 열 때와 같은 `openShellConnection` 을 같은 세션 ID 로 다시 부른다 (점프 호스트 포함, 바뀐 호스트 키는 확인 창). 자동 재연결(`reconnectOnce`)은 여전히 점프 호스트를 무시한다.
- 바꾸면 안 되는 것: 두 연결 함수의 `stream.on('close')` 는 그 셸이 아직 `sshConnections` 의 현재 셸일 때만 처리한다. 재연결로 바뀐 옛 셸의 늦은 close 가 새 연결을 끊김으로 표시하거나 자동 재연결을 또 시작하면 안 된다. 같은 이유로 자동 재연결은 상태가 `reconnecting` 일 때만 셸을 붙이고 다시 시도한다.
- 셸이 스스로 끝난 경우(`exit`, 서버의 `TMOUT` 자동 로그아웃)는 끊김이 아니다: 셸 채널의 `exit` 이벤트로 종료 코드를 받았으면 자동 재연결하지 않고 "셸이 종료되었습니다" 안내와 `재연결` 을 보여 준다 (`main.js` 의 `endedByItself`, `reportShellExit`). 바꾸면 안 되는 것: 이때 SSH 연결은 닫지 않는다 (SFTP 패널과 DB 탭이 같은 연결을 쓴다. 셸이 끝나도 DB 조회는 계속된다). `TMOUT=300` 같은 정상 셸 종료에서 재연결하면 터미널과 DB 접속도 끊길 수 있다 (`docs/fix/2026-11-13-shell-exit-reconnect-loop.md`). 신호로 죽은 셸과 종료 코드 없이 닫힌 채널은 지금처럼 재연결한다. 끊긴 이유는 콘솔에 남는다 (`traceShellEnd`).
- 다시 연결되면 `TerminalPanel` 이 터미널 크기를 서버에 다시 보낸다 (새 셸은 80x24 로 열린다).
- 별도 창으로 분리한 터미널(`TerminalWindow.tsx`)도 같은 카드를 쓴다. 그 창은 터미널 스토어가 없어 연결 이벤트를 직접 듣고 같은 계산(`lib/connectionLost.ts` 의 `linkConnected`/`linkDisconnected`/`linkReconnecting`)으로 상태를 둔다. `종료` 는 연결을 끊고 창을 닫는다.
