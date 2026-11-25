# 세션 공유와 가져오기

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

## Session Share Text (연결 정보 복사·텍스트로 세션 추가)

세션·폴더 우클릭의 `연결 정보 복사` 로 연결 정보를 메신저용 텍스트로 복사하고, 받은 사람은 사이드바 버튼 줄이나 폴더 우클릭의 `텍스트로 세션 추가`(`Sidebar/SessionImportDialog.tsx`)로 넣는다. 폴더는 하위 폴더·세션 전부가 같은 구조로 만들어진다 (`materializeFolder`, 새 id). 세션 하나는 기존 새 연결 창(`duplicateFrom`, 제목 `공유받은 세션 추가`)으로 열어 저장한다. 형식과 검사는 `lib/sessionShare.ts`, 설계: `docs/plan/2026-11-12-session-share-text.md`.
- 형식: 사람용 첫 줄 + `ezshell-session:v1:<base64url JSON>[.<암호 상자>]`. JSON 은 `{ session }` / `{ folder }` 이고 비밀번호를 담지 않는다.
- 비밀번호는 `비밀번호 포함 복사…` 에서 사용자가 정한 공유 암호로만 암호화한다 (`lib/shareCrypto.ts`, PBKDF2-SHA256 600,000회 → AES-256-GCM). 받는 쪽은 공유 암호로 풀거나 `비밀번호 없이 추가`.
- 바꾸면 안 되는 것: 앱에 키를 넣어 암호화하지 않는다 (앱을 받은 누구나 풀 수 있다). 암호화의 AAD 는 토큰의 평문 부분 글자 그대로다: 누가 텍스트의 호스트를 바꿔 치면 풀리지 않아야 한다 (안 그러면 받는 사람이 공유 암호를 넣는 순간 비밀번호가 바꿔 친 서버로 간다). 받는 텍스트의 평문 비밀번호 항목, `mcpEnabled`, 개인 키 경로, id·폴더 id 는 버린다. 호스트·계정·이름은 제어 문자(C0·C1, 줄 구분자, 보이지 않는 서식 문자 `\p{Cf}`)를 앞뒤 공백 정리 전에 거부한다. 자동 실행 스크립트는 CRLF 를 LF 로 바꾼 뒤 줄바꿈·탭 말고는 거부한다 (홀로 있는 CR 은 서버에서 Enter 로 실행되는데 미리보기에는 한 줄로 보인다). 반복 횟수는 100,000~2,000,000 만 받는다. 자동 실행 스크립트는 가져오기 화면에 전체 원문(안쪽 스크롤 없음)과 줄 수로 보여 주고, "모두 읽었다" 체크를 해야 추가된다. 공유 암호는 10자 이상, NFC 로 정규화하고, `무작위로 만들기`(약 79비트)가 있다. 큰 토큰은 zod 전에 크기(평문 1MB)와 객체 수(20,000)로 거른다.

## Session Import From Other Programs (다른 프로그램에서 가져오기)

설정 > 세션 백업의 `다른 프로그램에서 가져오기`(`Settings/ExternalImportDialog.tsx`, 트리 `ExternalImportTrees.tsx`, 계산 `lib/externalImport.ts`)는 Xshell·Xftp(`.xsh`/`.xfp`/`.xts`)·PuTTY(레지스트리·`.reg`)·MobaXterm(`.mxtsessions`/`MobaXterm.ini`)·Tabby(`config.yaml`)·FileZilla(`sitemanager.xml`)·OpenSSH config 의 세션을 옮긴다. 해석은 main 의 `src/sessionImport/` (프로그램별 파일, `model.js` 가 정리·제한, `sources.js` 가 이 PC 에서 찾기, `ipc.js`). 화면은 `내 세션 | 가져온 세션` 두 패널이고, 가져온 쪽의 폴더·세션을 내 쪽 폴더(또는 최상위)로 끌어 놓거나 `← 선택 항목 넣기`, `모두 적용`(체크한 것 전부를 `가져옴 - <프로그램>` 폴더로). `적용` 전에는 저장하지 않는다. 세션 행 위에 놓으면 그 세션의 앞(위쪽 절반)이나 뒤(아래쪽 절반)에 들어가고, 저장 순서도 그대로다 (`mergeOrder`, 같은 세션 뒤에 여러 개면 놓은 순서). `새 폴더` 로 내 쪽에 폴더를 만들 수 있다 (고른 폴더 아래, 적용 때 생성). 설계: `docs/plan/2026-11-13-session-import-other-apps.md`.
- 1단계는 비밀번호를 읽지 않는다 (원래 프로그램에 저장돼 있었는지만 `비밀번호 다시 입력` 으로 표시). Xshell 저장 비밀번호는 2단계로 따로 다룬다. Termius 는 읽을 파일이 없어 OpenSSH config 로 내보낸 것을 고르게 한다.
- 바꾸면 안 되는 것: 창은 경로를 보내지 않는다 (`session-import-read` 는 마지막 목록의 id 만, 파일은 main 의 선택 창). 본창에서만 받는다. 들어온 세션은 MCP 접근 허용이 꺼진 채로, 자동 실행 스크립트·root 전환 없이 들어온다. 제한: 파일 5MB, 세션 2,000·폴더 500개, `.xts` 는 항목 3,000개·풀린 합 20MB·`..`/절대 경로 항목 건너뜀(zip 이름은 직접 해석해서 나쁜 항목 하나로 전체가 실패하지 않게).
- 보안 검토 반영: 키 파일 경로는 이 PC 의 절대 경로만 받는다 (`src/localKeyPath.js` 의 `isLocalFilePath`). 남이 준 파일의 `\\host\share\id` 같은 네트워크 경로는 접속할 때 Windows 가 그 호스트로 NTLM 자격 증명을 보내고, `\\.\pipe\` 같은 장치 경로는 읽기가 끝나지 않는다. 가져올 때 비우고(`키 파일을 직접 골라 주세요`), 바꾸면 안 되는 것: 터미널 접속(`main.js` 세 곳)과 연결 테스트·MCP(`sshConnectionTest.js`)도 키를 `readPrivateKeyFile` 로만 읽는다. 호스트는 글자·숫자·`.`·`-`·`:`·`[]`·`%` 만, 맨 앞 `-` 거부(명령줄 옵션으로 읽힘). 계정은 공백·`@`·`:`·따옴표·맨 앞 `-` 거부. 이름의 보이지 않는 문자(`\p{Cf}` 등)는 지운다. `reg.exe` 는 전체 경로로 부른다.
- MobaXterm 형식은 공식 문서가 없어 커뮤니티 분석(호스트 1, 포트 2, 계정 3, 게이트웨이 8~10, 키 14)을 따른다. 실제 내보내기 파일로 확인하지 못했다.
- FileZilla(`filezilla.js`, 2026-11-23 사용자 요청): 사이트 관리자 `sitemanager.xml`(Windows `%APPDATA%\FileZilla`, 그 밖 `~/.config/filezilla`)이나 내보낸 `.xml`. SFTP 사이트(`Protocol` 1)만 가져오고 FTP·FTPS 는 세어서 뺀다. `<Folder>` 안의 글자가 폴더 이름, `Logontype` 5 의 `Keyfile` 이 키 파일이다 (`.ppk` 는 ssh2 가 PPK 2 의 RSA·DSA 만 읽어서 안내를 붙인다). `<Pass>` 는 있는지만 본다. XML 은 직접 만든 작은 파서로 읽는다 (`parseXml`: DOCTYPE 거부, 깊이 64·요소 20만 상한). 이 PC 의 실제 파일로 확인했다.
- 의존성 `iconv-lite`(cp949 이름), `js-yaml`(Tabby, 기본 스키마), `yauzl`(`.xts`) 은 정확한 버전으로 고정했다. 새 `src/` 폴더라서 `MAIN_RUNTIME_DIRECTORIES` 에 `sessionImport` 가 있다.
