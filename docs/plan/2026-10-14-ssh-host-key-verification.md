# SSH 호스트 키 검증

- 날짜: 2026-10-14
- 구분: 보안 경계 (설계 문서 → 테스트 먼저 → 구현 → 보안 검토 1회)
- 상태: 구현 완료, 보안 검토 반영 (실제 sshd 수동 확인 전)

## 문제

ssh2 는 `hostVerifier` 가 없으면 서버가 보낸 호스트 키를 무조건 받아들인다. 지금은 모든 연결 경로에 검증이 없어서,
중간에서 서버인 척하는 공격자에게 비밀번호를 그대로 보낸다.

## 결정 사항

1. **저장 방식**: `userData/known-hosts.json`. 서버마다 키 종류와 SHA256 지문(OpenSSH 형식 `SHA256:...`)만 둔다.
   서버 주소는 평문으로 남기지 않고 파일마다 다른 난수 salt 로 HMAC-SHA256 한 값을 키로 쓴다 (OpenSSH 의 HashKnownHosts 와 같은 방식).
   세션 파일은 마스터 비밀번호로 암호화되어 있는데 이 파일이 서버 목록을 평문으로 드러내면 안 되기 때문이다.
2. **기준**: 호스트(소문자) + 포트 하나에 키 하나. 다른 종류의 키가 와도 "바뀜" 으로 본다 (공격자가 다른 키 종류를 내밀어 "처음 보는 서버" 로 보이게 하는 것을 막는다).
3. **처음 보는 서버 / 바뀐 키 (터미널 연결, 연결 테스트)**: 연결을 바로 끊고 확인 창을 띄운다. 사용자가 신뢰하면 저장하고 처음부터 다시 접속한다.
   핸드셰이크 도중에 창을 띄워 기다리면 `readyTimeout`(20초)과 서버의 LoginGraceTime 에 걸려 연결이 끊기므로, "끊고 묻고 다시 접속" 방식으로 한다.
   다시 접속했을 때 키가 또 다르면 다시 묻는다 (한 번의 연결에서 최대 3번).
4. **바뀐 키 창**: 경고 문구, 저장된 지문과 새 지문을 함께 보여 준다. 기본 초점은 "접속 안 함". "새 키로 바꾸고 접속" 은 창이 뜬 뒤 0.8초 동안 눌리지 않는다.
5. **자동 재연결**: 묻지 않는다. 키가 저장된 것과 다르면 재연결을 멈추고 이유를 알린다. 재연결 중의 키 변경은 공격 신호가 강하므로, 사용자가 직접 다시 연결해 확인 창을 보도록 한다.
6. **MCP 연결**: 묻지 않는다. 저장된 키가 없거나 다르면 거부한다. 사람이 없을 수 있기 때문이다.
   안내 문구: 앱에서 그 세션에 한 번 접속(또는 연결 테스트)해 호스트 키를 확인하라고 알린다.
7. **점프 호스트**: 점프 호스트와 대상 서버를 각각 검증한다. 대상 서버는 점프 호스트에서 본 주소(설정의 host:port)로 기록한다.
8. **확인 창 응답**: main 이 요청 ID 를 만들고, 렌더러는 ID 와 결정(trust/reject)만 돌려준다. 렌더러가 지문이나 키를 보내 저장시키는 경로는 없다.
   120초 동안 응답이 없거나 창이 없으면 거부한다. 같은 서버·같은 지문의 확인 요청이 동시에 오면 하나의 창을 함께 쓴다.
9. **파일이 깨졌을 때**: `known-hosts.json.corrupt-<시각>` 으로 옮겨 두고 빈 목록으로 시작한다 (앱 전체가 접속 불가가 되지 않게). 결과적으로 모든 서버가 "처음 보는 서버" 가 되어 다시 묻는다.
10. 분할 셸, SFTP, 포트 포워딩은 이미 검증된 연결을 다시 쓰므로 따로 검증하지 않는다.

## 인터페이스 (코드 없이)

`src/hostKeys/` (main 런타임 디렉터리로 복사, `electron.vite.config.ts` 의 `MAIN_RUNTIME_DIRECTORIES` 에 추가)

- `hostKeyStore.js`
  - `describeHostKey(keyBuffer) → { keyType, fingerprint }`
  - `createHostKeyStore({ filePath, fs? }) → { check(host, port, keyBuffer), trust(host, port, keyBuffer) }`
  - `check` 결과: `{ status: 'trusted' | 'unknown' | 'changed', keyType, fingerprint, previous?: { keyType, fingerprint } }`
- `hostKeyCheck.js`
  - `HostKeyError` (`reason: 'unknown' | 'changed' | 'rejected'`, `info`)
  - `withHostKeyCheck({ store, prompt?, maxPrompts = 3 }, attempt)`: `attempt(verifierFor)` 를 실행. `verifierFor(host, port)` 는 ssh2 `hostVerifier` 함수를 돌려준다.
    거부된 키가 있으면 `prompt` 로 묻고, 신뢰하면 저장 후 다시 `attempt`. `prompt` 가 없으면 `HostKeyError`.
  - `hostKeyMessage(err) → { error, hint }` 한국어 문구
- `hostKeyPrompt.js`
  - `createHostKeyPrompter({ send, timeoutMs = 120000 }) → { prompt(info), respond(id, decision), dismissAll() }`

연결 지점

- `main.js`: `ssh-connect`(대상 + 점프), `reconnectSession`(대상 + 점프 없음, 묻지 않음), `ssh-test-connection`
- `src/sshConnectionTest.js`: `deps.verifierFor` 를 받아 대상·점프 클라이언트에 넣는다
- `src/mcp/sessionGateway.js`: `hostKeys` 옵션, 묻지 않는 `withHostKeyCheck`
- `src/mcp/controller.js`: `hostKeys` 를 받아 게이트웨이에 넘긴다
- `src/preload.js`: `onHostKeyPrompt`, `respondHostKey`
- 렌더러: `components/Modal/HostKeyDialog.tsx` (App.tsx 에 한 번 마운트)

## 테스트 목록 (먼저 작성)

hostKeyStore
- 처음 보는 서버는 unknown, 저장 후 trusted
- 같은 서버에 다른 키는 changed, previous 에 저장된 지문
- 포트가 다르면 다른 서버, 호스트 대소문자는 같은 서버
- 파일에 서버 주소가 평문으로 남지 않는다
- 깨진 파일은 옆으로 옮기고 빈 목록으로 시작
- 지문 형식이 OpenSSH 와 같다 (`SHA256:` + base64, 패딩 없음)

withHostKeyCheck
- 저장된 키면 묻지 않고 attempt 결과를 돌려준다
- prompt 가 없으면 unknown / changed 로 HostKeyError, 저장하지 않는다
- 신뢰하면 저장하고 다시 시도, 거부하면 HostKeyError(rejected) 이고 저장하지 않는다
- 다시 시도에서 키가 또 다르면 다시 묻고, maxPrompts 를 넘으면 실패
- attempt 가 다른 이유로 실패하면 그 오류를 그대로 던진다
- 점프 + 대상 둘 다 처음이면 두 번 묻는다

hostKeyPrompt
- respond 로 받은 결정을 돌려준다, 모르는 ID 는 무시
- 시간 초과와 send 실패는 reject
- 같은 서버·지문의 동시 요청은 창 하나
- dismissAll 은 대기 중인 요청을 모두 reject

sessionGateway / sshConnectionTest
- MCP 연결은 저장된 키가 없으면 접속하지 않는다 (verifier 가 false)
- 연결 테스트는 처음 보는 서버면 묻고, 거부하면 실패 결과 (stage 표시)

## 보안 검토 반영 (2026-10-14, 1회)

CRITICAL, HIGH 는 없었다. 반영한 것:
- (MEDIUM) 파일이 있는데 읽지 못하면(다른 프로그램이 잠금 등) 빈 목록으로 시작해 첫 저장에서 기존 키를 모두 덮어썼다.
  이제 그 경우는 캐시하지 않고 저장을 거부한다. 접속은 실패하고, 다음 접속에서 파일을 다시 읽는다.
- (LOW) 임시 파일에 쓴 뒤 fsync 하고 이름을 바꾼다. 실패하면 임시 파일을 지운다.
- (LOW) 신뢰한 키를 저장하지 못하면 접속하지 않는다 (`HostKeyError('unsaved')`, 안내 문구 포함).

반영하지 않은 것:
- (MEDIUM) 호스트마다 키 하나: 서버가 여러 종류의 키를 갖고 있거나 로드밸런서 뒤의 서버마다 키가 다르면 "바뀜" 오탐이 날 수 있다.
  ssh2 의 키 알고리즘 협상은 클라이언트 선호 순서를 따르므로 같은 서버에서는 결과가 바뀌지 않는다. 다른 종류의 키를 "처음 보는 서버" 로 취급하면 공격자가 경고를 피할 수 있어서 그대로 둔다.
- (LOW) 주소 HMAC 은 salt 가 같은 파일에 있어 이름 목록이 있으면 사전 대입으로 복원된다 (OpenSSH 와 같은 수준).
- 렌더러가 탈취되면 확인 없이 `respondHostKey(id, 'trust')` 를 보낼 수 있다. main 에서 막을 수 없고 렌더러 보호(CSP 등)에 달려 있다.

## 확인하지 못한 것 / 남은 일

- 실제 sshd 에 대한 수동 확인 (처음 접속 창, 키 변경 경고)
- 저장된 호스트 키를 보고 지우는 설정 화면은 이번 범위에 넣지 않았다
- 기존 문제(이번 변경과 무관): 자동 재연결(`reconnectOnce`)은 점프 호스트 설정을 무시하고 대상에 직접 접속한다. 호스트 키 검증은 대상 서버 기준으로 정상 수행된다.
- 잠금 상태에서 `ssh-connect` 가 들어오면 확인 창이 잠금 화면 위에 보이는지 확인하지 않았다 (잠금 중에는 렌더러가 연결을 시작하지 않는다)
