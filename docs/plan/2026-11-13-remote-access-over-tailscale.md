# 원격 접속: 휴대폰 브라우저에서 터미널 쓰기 (Tailscale)

- 날짜: 2026-11-13
- 구분: 큼 (보안 경계: 운영 서버 셸을 여는 화면을 네트워크에 내놓는다)
- 상태: 1단계 구현·확인 완료 (배포 전)

## 요청
밖에 있을 때 휴대폰으로 (1) 아무 세션이나 터미널을 열어 조작하고 (2) MCP 허용 요청에 답한다. 본인만 쓴다. Tailscale 을 쓴다.

## 결정
- PC 의 ezShell 이 웹 화면을 내고 휴대폰 브라우저가 접속한다. SSH 연결과 비밀번호는 PC 에만 있다.
- 통로는 Tailscale 뿐이다. 앱은 Tailscale 주소(100.64.0.0/10, fd7a:115c:a1e0::/48)에만 포트를 열고, 그 대역에서 온 접속만 받는다. Tailscale 주소가 없으면 켜지지 않는다. 다른 주소(0.0.0.0, LAN, 인터넷)로 여는 선택지는 만들지 않는다.
- 통신은 Tailscale(WireGuard)이 암호화하므로 그 안에서는 HTTP·WebSocket 평문을 쓴다. (HTTPS 는 인증서 발급·경고 문제 때문에 1단계에서 넣지 않는다.)
- 기본은 꺼짐. 설정 > 원격 접속에서 켠다.

## 인증 (둘 다 필요)
1. 기기 등록: PC 화면의 QR(주소 + 1회용 코드, 2분, 한 번만) → 휴대폰이 기기 토큰(난수 32바이트)을 받아 브라우저에 둔다. PC 에는 토큰의 SHA-256 만 둔다.
2. 접속할 때마다 인증 앱의 6자리 코드(TOTP). 같은 코드는 다시 받지 않는다.
- 인증 코드를 5번 틀리면 그 기기만 5분 동안 거부한다. 그 밖의 실패는 연결별(5번)·주소별(5분에 10번)로 막는다. (처음에는 모두에게 걸었으나, 아무 기기가 주인을 막을 수 있어 바꿨다.)
- 15분 동안 입력이 없으면 끊는다. 앱을 잠그면 모두 끊고, 잠긴 동안 받지 않는다.
- WebSocket 의 Origin 과 Host 가 이 서버가 연 주소일 때만 받는다.

## 1단계 범위
- 세션 목록(이름·폴더만. 주소·계정은 보내지 않는다) → 고르면 PC 가 그 세션에 접속해 셸을 열고 휴대폰과 잇는다.
- 저장된 호스트 키만 받는다 (사람이 PC 앞에 없다: MCP 와 같은 규칙). 점프 호스트, root 전환 지원.
- 휴대폰 터미널: xterm.js, `Ctrl`·`Tab`·`Esc`·방향키 줄.
- 설정 화면: 켜기/끄기, 등록 QR, 인증 앱 QR, 등록된 기기 목록과 해제, 접속 중 표시.
- 기록: `userData/remote-access.log` (시각, 기기, 한 일. 입력·출력은 남기지 않는다).

## 2단계: 휴대폰 화면을 PC 수준으로 (사용자 승인 2026-11-13, 진행 중)
1단계(2.16.0)에는 터미널만 있다. 사용자 요청: 세션 목록의 폴더 색 등 디자인, MCP 확인 요청에 답하기, MCP 활동 보기, 휴대폰 알림(텔레그램은 쓰지 않는다).

### 범위
1. 세션 목록: PC 사이드바와 같은 폴더 구조(접기·펼치기), 폴더 색·세션 색, 사이드바 순서, 열린 탭 상태 점.
2. MCP 확인 요청에 답하기: PC 에 확인 창이 뜰 때 같은 요청을 인증된 기기에도 보낸다(나중에 접속한 기기는 인증 직후 받는다). 어느 화면에 있든 카드가 위에 뜨고 `허용`/`거부` 로 답한다. 답은 PC 창과 같은 경로(`approvals.respond`)로 들어가고 PC 창은 닫힌다. 내용은 PC 창과 같고 명령은 원문 그대로 보여 준다. 카드가 뜬 뒤 0.8초 동안 버튼이 눌리지 않고, diff 는 끝까지 내려야 `허용` 이 눌린다. 감사 로그에 답한 기기를 남긴다.
3. 대기 시간: "휴대폰으로 확인 요청 받기" 가 켜져 있고 요청이 휴대폰에 닿을 수 있으면(접속 중인 기기가 있거나, 알림을 켠 기기가 있으면) 확인 대기 시간을 4분으로 늘린다 (지금 60초, 파일 180초). 5분이 아닌 이유: Claude Code 는 5분 동안 응답이 없는 HTTP MCP 호출을 끊는다(문서 확인).
4. 알림: 웹 푸시. 휴대폰 브라우저가 닫혀 있어도 알림이 온다(안드로이드 Chrome). 푸시는 HTTPS 페이지에서만 되므로 Tailscale 인증서(`tailscale cert`, 이 PC 의 `*.ts.net` 이름)로 HTTPS 를 연다. Tailscale 관리 화면에서 HTTPS 인증서를 켜야 한다(사용자가 한 번). 켜지 않았으면 지금처럼 HTTP 로 열고 알림만 없다. PC 에서 15초 안에 답하지 않았을 때만 보내고, 내용은 요청 종류와 위험도뿐이다(명령·경로·세션 이름·주소 없음, 본문은 브라우저까지 암호화되어 간다).
5. MCP 활동 보기: 요청 목록과 상태, 명령과 출력을 시간순으로(PC 의 `터미널` 보기 하나). 실행 중인 요청은 `중지`. 활동 화면을 보고 있는 기기에만 보내고 휴대폰에 저장하지 않는다.
- 바꾸지 않는 것: 절대 차단 명령은 실행할 수 없다. 인증(기기 토큰 + 인증 코드)을 마친 기기만 보고 답한다. 앱을 잠그면 모두 끊는다.
- 함께: 명령 팔레트 `업데이트 내용 보기` 가 최근 10개 버전 이력을 보여 주게 한다.

### 나눠서 작업
- 이 세션(main·서버): `src/remoteAccess/*.js`, `main.js`, `src/mcp/*`, 설정 화면, HTTPS·푸시, 문서.
- 옆 세션(휴대폰 화면): `src/remoteAccess/web/*` 만. 아래 프로토콜에 맞춰 만들고, 서버 쪽이 끝나기 전에는 흉내 서버(스크래치 스크립트)로 390px 화면에서 확인한다. 그리고 `업데이트 내용 보기` 이력, 파일 영역 그리기 성능 보완.
- 두 세션이 같은 폴더에서 일하므로 서로의 파일은 건드리지 않는다. `CLAUDE.md` 와 이 문서는 이 세션만 고친다.

### 프로토콜 (WebSocket JSON, 1단계 메시지는 그대로)
서버 → 휴대폰
- `ready` 에 추가: `folders: [{ id, name, parentId|null, color|null }]`, `sessions: [{ id, name, folderId|null, color|null, folder(폴더 이름, 옛 화면용), openTabs: { connected, disconnected } }]` (둘 다 PC 사이드바 순서), `approvals: 요청[]`(지금 묻고 있는 것, 0~1개), `push: { available, publicKey|null }`.
- `sessions` `{ folders, sessions }` (`sessions` 요청의 답, 같은 형태)
- `approval` `{ request }`: 확인 요청이 시작됨. `request` 는 PC 확인 창이 받는 것과 같은 객체다 (`src/renderer/types/index.ts` 의 `McpApprovalRequest`: id, sessionName, folder, cwd, command, purpose, level, reasons, expiresAt, background, kind, 파일은 path·isNew·added·removed·hunks 등, 전송은 direction·localPath·remotePath·size 등).
- `approval-closed` `{ id, outcome: 'approved'|'denied'|'expired'|'cancelled', by: 'pc'|'device'|null }`: 그 요청이 끝남(누가 답했든). 카드를 내린다.
- `approval-result` `{ id, ok, message? }`: 이 기기가 보낸 답의 결과 (`ok: false` 면 이미 끝난 요청).
- `activity` `{ items }`: `activity-list` 의 답. `McpActivityItem`(같은 파일) 배열, 오래된 것부터, 최대 100개. 항목의 `outputParts` 는 마지막 16KB 만.
- `activity-item` `{ item }`: 항목이 생기거나 바뀜 (`activity-watch` 를 켠 기기에만). `outputParts` 가 들어 있으면 그것이 기준이다(마지막 16KB).
- `activity-output` `{ id, parts }`: 실행 중 출력 조각 (`McpOutputPart[]`, 켠 기기에만).
- `activity-stop-result` `{ id, ok, message? }`
- `push-result` `{ ok, message? }`
휴대폰 → 서버
- `approval-respond` `{ id, approved: boolean }`
- `activity-list` `{}`, `activity-watch` `{ on: boolean }`, `activity-stop` `{ id }`
- `push-subscribe` `{ subscription }`(PushSubscription.toJSON()), `push-unsubscribe` `{ endpoint }`
푸시 본문(서비스 워커 `sw.js` 가 받는 JSON): `{ title, body, tag }`. 알림을 누르면 `/` 를 연다(열려 있으면 그 탭으로).
정적 파일: `/`, `/app.js`, `/app.css`, `/sessions.js`, `/approvals.js`, `/activity.js`, `/push.js`, `/sw.js`, `/vendor/*` 만 제공한다. CSP 는 `default-src 'self'` 라 인라인 스크립트·외부 자원은 쓸 수 없다.

### 진행
- [x] 프로토콜 서버 쪽: 세션 트리, 확인 요청 전달·응답·대기 시간·감사 로그, 활동
- [x] HTTPS(Tailscale 인증서)와 웹 푸시: 임시 인증서로 실제 모듈 전체 경로 확인(21가지). Tailscale 이 내주는 진짜 인증서와 실제 푸시 서비스로는 아직 확인 못 함 (사용자가 Tailscale HTTPS 를 켠 뒤)
- [x] 휴대폰 화면: 세션 트리, 확인 카드, 활동, 알림 켜기 (옆 세션. 흉내 서버와 390px 화면에서 확인)
- [x] `업데이트 내용 보기` 이력, 파일 영역 그리기 성능 (옆 세션)
- [x] 실제 앱 통합 확인: 진짜 MCP 호출이 일으킨 확인 요청을 휴대폰 쪽에서 받아 허용·거부, 감사 로그, 활동 (24가지). 휴대폰 화면도 진짜 서버에 붙여 세션 트리, 확인 카드에서 허용, 활동 화면, 터미널을 확인
- [x] 보안 검토 (2단계 변경분): 높음 없음. 반영: 대기 시간 연장을 휴대폰에 닿을 수 있을 때로 한정, 활동 항목 필드 한정과 밀린 기기 건너뛰기, TCP 단계 주소 검사, 이름 없는 세션에 주소 대신 표지, `tailscale` 실행 경로·이름 검증 강화, 끌 때 인증서 파일 삭제, 기기에서 한 중지의 감사 기록, 긴 명령은 끝까지 내려야 허용(휴대폰 화면). 반영하지 않음: 0.8초 규칙의 서버 기준을 "화면에 뜬 시각"으로 바꾸는 것(화면 쪽 규칙이 실제 방어이고, 서버는 보낸 시각 기준으로 한 번 더 본다), 위험도별 대기 시간, PC 창의 "휴대폰 응답 대기 중" 표시.
- [ ] 사용자 확인 필요: Tailscale 관리 화면에서 HTTPS 인증서를 켠 뒤 실제 인증서 발급과 휴대폰 알림, 실제 휴대폰에서의 동작

## 3단계 (다음)
- PC 에 열려 있는 탭 이어 보기.

## 구성
- `src/remoteAccess/totp.js` TOTP, `tailnet.js` 주소 판정, `accessStore.js` 등록·기기·실패 제한, `shells.js` SSH 셸, `server.js` HTTP·WebSocket, `web/` 휴대폰 화면.
- `controller.js` 가 위를 묶어 main.js 에 연결한다 (IPC, 잠금 연동, 기록 파일). 설정 화면은 `components/RemoteAccess/RemoteAccessSettings.tsx`.
- 의존성: `ws`, `qrcode`. 휴대폰 화면의 xterm 은 빌드 때 `out/main/src/remoteAccess/web/vendor` 로 복사한다 (xterm 은 devDependency 라 설치본에 node_modules 사본이 없다).

## 구현하면서 정한 것
- 인증 앱 비밀 키는 파일에 평문으로 두지 않고 Electron safeStorage 로 봉인한다 (`totpSecretSealed`). 백업 등으로 파일만 새어 나가도 키를 알 수 없다.
- 셸이 열리는 중(수 초)에 기기가 끊기거나 앱이 잠기면, 다 열린 뒤에 바로 닫는다 (`shells.js` 의 `goneOwners`, `epoch`). 열리는 중인 셸도 개수 제한(6개)에 센다.
- 잠글 때 휴대폰에는 "PC 의 ezShell 이 잠겼습니다" 라고 알리고, 잠긴 동안에는 포트를 닫는다.
- 기록 파일은 1MB 를 넘으면 뒤쪽 절반만 남긴다.

## 보안 검토 (2026-11-13, 별도 에이전트)
인증 우회나 남의 셸에 닿는 결함은 없었다. 반영한 것:
- 높음: 등록 코드에 한글 등을 넣으면 비교 함수가 예외를 던지던 것, 자리가 찬 뒤 온 소켓에 오류 처리기가 없던 것, 설치본에 xterm 이 없어 요청마다 예외가 나던 것 (셋 다 인증 전에 main 에 예외를 일으킬 수 있었다).
- 중간: Tailscale 인터페이스의 주소만 쓰기, Origin·Host 를 연 주소와 비교, 전체 잠금을 기기별·연결별·주소별 제한으로, 인증 전 연결을 접속 수와 따로 세기, 셸 출력 묶음 전송과 밀릴 때 읽기 멈춤.
- 낮음: 기록에 실패한 접속의 주소 남기기와 실행 중 크기 확인, 기기 해제 때 셸을 바로 닫고 2초 뒤 소켓 끊기, 봉인할 수 없으면 켜지 않기(평문 저장 없음), 잠긴 동안 설정 IPC 거부, 동시에 두 번 시작해도 한 번만 열기, CSP 의 소켓 주소를 이 서버로 한정, 출력의 한글이 청크 경계에서 깨지지 않게, `::ffff:` 뒤는 IPv4 로만 읽기.
- 반영하지 않은 것: 세션별 "원격 접속 허용". 모든 세션을 휴대폰에서 열 수 있어야 한다는 것이 요구 사항이다. 대신 휴대폰을 잃으면 설정에서 기기를 해제하고 Tailscale 에서도 그 기기를 뺀다.

## 진행
- [x] totp, tailnet, accessStore 와 테스트
- [x] shells, server
- [x] 휴대폰 화면
- [x] 설정 화면, main 연결, 잠금 연동
- [x] 실제 앱 확인: 설정 화면 → 등록 → 인증 → 셸 입력 → 기기 해제 → 잠금 (개발 빌드 36가지, 휴대폰 화면은 390px 브라우저, 설치본 형태 13가지)
- [ ] 실제 휴대폰에서 확인 (QR 촬영, 화면 키보드, 인증 앱): 사용자 확인 필요
