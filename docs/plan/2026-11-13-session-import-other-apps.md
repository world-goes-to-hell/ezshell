# 다른 프로그램의 세션 가져오기 (1단계: 비밀번호 제외)

- 날짜: 2026-11-13
- 구분: 큼 (사용자가 준 파일과 이 PC 의 다른 프로그램 설정을 읽는다. 해석기는 테스트 먼저, 끝나면 보안 검토)
- 상태: 진행 중

## 요청
Xshell·Xftp·PuTTY·MobaXterm·Tabby 를 쓰던 사람의 세션을 ezShell 로 옮긴다. Termius 는 읽을 수 있는 파일이 없어 OpenSSH config 가져오기로 대신한다.
UX(사용자 요청): `내 세션 | 가져온 세션` 두 패널을 나란히 두고, 가져온 쪽에서 원하는 폴더·세션만 끌어다 내 쪽 폴더에 넣는다. `모두 적용` 도 둔다.

## 1단계 범위 (사용자 승인)
- 호스트·포트·계정·폴더 구조·점프 호스트(첫 홉)·키 파일 경로. **저장된 비밀번호는 읽지 않는다** (원래 프로그램에 저장돼 있었는지만 표시). Xshell 비밀번호는 2단계에서 따로.
- SSH(Xshell 의 SFTP 포함)만. Telnet·RDP·시리얼 등은 건너뛰고 수를 알려 준다.

## 형식 (확인한 것)
- Xshell: `문서\NetSarang Computer\<버전>\Xshell\Sessions\**\*.xsh` (UTF-16LE INI, 하위 폴더 = 폴더). `[CONNECTION] Host/Port/Protocol`, `[CONNECTION:AUTHENTICATION] UserName/Password/UserKey`. `UserKey` 는 Xshell 키 저장소의 이름이라 경로가 없다(키 파일은 직접 고르라고 표시). 내보내기 `.xts` 는 같은 파일들의 zip.
- Xftp: `Xftp\Sessions\**\*.xfp` (같은 INI). 이 PC 에 표본이 없어 SFTP·22번 포트인 것만 받는다.
- PuTTY: 레지스트리 `HKCU\Software\SimonTatham\PuTTY\Sessions` (`reg export` → `.reg` 와 같은 해석기). 이름은 퍼센트 인코딩 + ANSI(cp949). `HostName`(user@host 가능), `PortNumber`, `UserName`, `Protocol`, `PublicKeyFile`, 프록시 `ProxyMethod=6`(SSH) → 점프 호스트.
- MobaXterm: `.mxtsessions`/`MobaXterm.ini`, ANSI, `[Bookmarks]`·`[Bookmarks_N]` 의 `SubRep`(폴더, `\` 로 중첩). SSH 값 `#109#0%host%port%user%…`: 1 호스트, 2 포트, 3 계정, 8·9·10 게이트웨이(`__PIPE__` 로 여러 홉), 14 키(`_CurrentDrive_` = C:). 비공식 분석 자료 기준 (https://gist.github.com/Ruzgfpegk/ab597838e4abbe8de30d7224afd062ea).
- Tabby: `config.yaml` 의 `profiles`(type ssh, `options.host/port/user/auth/privateKeys/jumpHost`(다른 프로필 id)), `groups`(id → 이름).
- OpenSSH: `~/.ssh/config` 의 `Host` 블록(와일드카드 제외, `Host *` 는 기본값), `HostName/Port/User/IdentityFile/ProxyJump`.

## 구조
- main `src/sessionImport/`: `model.js`(정규화·제한·정리), `xshell.js`, `putty.js`, `mobaxterm.js`, `tabby.js`, `sshConfig.js`, `sources.js`(이 PC 에서 찾기·읽기), `ipc.js`. 새 폴더라 `MAIN_RUNTIME_DIRECTORIES` 에 추가.
- IPC(본창만): `session-import-sources`(인자 없음), `session-import-read`(목록의 id 만), `session-import-file`(main 의 파일 선택 창).
- 제한: 파일 5MB, 세션 2,000개, 폴더 500개, zip 항목 3,000개·풀린 크기 합 20MB·`..` 경로 거부. 글자는 제어 문자 제거·길이 제한.
- 의존성 고정: `js-yaml@4.3.2`, `yauzl@2.10.0`, `iconv-lite@0.6.3` (이미 node_modules 에 있던 판).
- 화면: 설정 > 세션 백업의 `다른 프로그램에서 가져오기` → `ExternalImportDialog`. 왼쪽 내 세션 트리(폴더·최상위가 끌어 놓을 곳, 추가 예정은 `새로` 표시와 ✕), 오른쪽 가져온 트리(체크박스, 표시: 비밀번호 저장돼 있었음·키·점프·이미 있음). 이미 있는 세션은 처음에 체크 해제. `적용` 때만 저장(세션 파일 암호화 그대로), MCP 접근 허용은 꺼짐. 계산은 `lib/externalImport.ts`(테스트).

## 진행
- [x] 해석기 테스트 → 해석기 (xshell 7, putty 4, mobaxterm 5, tabby·sshConfig 4, model 5, sources 3)
- [x] IPC, preload, 타입
- [x] `externalImport.ts` 테스트(7) → 구현, 대화상자
- [x] 타입 검사, 전체 테스트 2,437개, 빌드
- [x] 이 PC 의 실제 설정으로 읽기 확인: Xshell 8 (폴더 9·세션 29, 비밀번호 저장 17, Xshell 키 14), Xftp 8 (세션 28), PuTTY (세션 1, 호스트 없는 1개 건너뜀), Tabby (폴더 2·세션 26, local 프로필 3개 건너뜀), OpenSSH config (1). 결과에 비밀번호 값 없음.
- [x] 보안 검토 (치명 0, 높음 1·중간 3 반영: 키 파일 경로를 이 PC 의 절대 경로로만(UNC·장치·상대·~·%VAR% 거부, `src/localKeyPath.js`, 접속·연결 테스트·MCP 의 키 읽기에도 적용), MobaXterm `_CurrentDrive_` → `C:`, 호스트·계정 글자 제한과 맨 앞 `-` 거부, 보이지 않는 문자 지우기 확대 / 낮음 반영: `reg.exe` 전체 경로, 폴더 탐색 전체 한도)
- [x] 사용자 요청 반영: 세션 사이 위치 지정(행의 위·아래 절반, 안내선, 저장 순서 유지 `mergeOrder`), 내 쪽 `새 폴더` (`addStagedFolder`), 테스트 12개
- [ ] 실제 앱 화면(드래그 드롭) 확인
- [x] CLAUDE.md
