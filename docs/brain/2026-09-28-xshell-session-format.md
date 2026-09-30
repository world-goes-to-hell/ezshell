# Xshell 8 세션을 옮길 때 알아야 할 형식

2026-09-28 사용자 요청으로 Xshell 세션 22개를 일회성으로 이 앱에 옮겼다 (앱 기능으로는 만들지 않음).
나중에 "Xshell 가져오기" 기능을 만들 때 다시 조사하지 않도록 형식을 남긴다.

## 파일
- 위치: `%USERPROFILE%\Documents\NetSarang Computer\8\Xshell\Sessions\` 아래 폴더 구조 그대로, 세션당 `.xsh` 1개
- 인코딩: **UTF-16 LE (BOM ff fe)** INI. UTF-8 로 읽으면 깨진다.
- 필요한 키: `[CONNECTION] Host, Port, Protocol`, `[CONNECTION:AUTHENTICATION] UserName, Password, UserKey, AuthMethodList, ExpectSend_*`
- `folder.cnf`, `*.xshf` 는 폴더/기본값 설정이라 무시해도 된다.

## 인증 방식 판별
`AuthMethodList=00,11,20,30` 은 (방법 숫자, 사용 여부) 쌍이다. 0=비밀번호, 1=공개키, 2=keyboard-interactive, 3=GSSAPI.
- 첫 번째로 켜진 방법이 공개키면 키 인증
- 비밀번호와 공개키가 둘 다 켜져 있어도 저장된 Password 가 없고 UserKey 가 있으면 키 인증 (예: `01,11`)
- UserKey 가 있어도 공개키가 꺼져 있으면(`10`) 비밀번호 인증

## 비밀번호 (Xshell 7.0 이상, 마스터 비밀번호 미설정 시)
- `Password` = base64( RC4(key, 평문) || SHA256(평문) )
- key = SHA256( reverse( reverse(Windows 사용자명) + 사용자 SID ) )
- 뒤 32바이트 SHA256 과 비교해 맞는 결과만 채택하면 오판이 없다. 이번에 17/17 일치.
- Node 17+ 의 OpenSSL 3 기본 provider 에는 rc4 가 없어서 직접 구현했다 (20줄).
- 평문은 파일/로그로 남기지 말 것. 이번에는 실행 중인 앱의 `saveSessions` IPC 로 넘겨 main 이 마스터 비밀번호로 암호화하게 했다.
  기존 `import-sessions` 는 받은 세션을 평문 그대로 sessions.json 에 쓰므로 비밀번호가 있는 데이터에는 쓰면 안 된다.

## 키
- `UserKey` 는 Xshell 키 저장소의 **이름**이다. 파일은 `...\NetSarang Computer\8\SECSH\UserKeys\<이름>.pri`
- `.pri` 는 `---- BEGIN NSSSH PRIVATE KEY ----` 형식(Xshell 전용)이라 ssh2 가 읽지 못한다.
  Xshell 사용자 키 관리자에서 OpenSSH 형식으로 내보내야 한다. 이 사용자는 이미 `D:\DEV\PROJECT_ETC\...\*.pem` 으로 내보내 둔 파일이 있어 그것을 연결했다.

## 로그인 후 명령
모든 세션이 `ExpectSend_Send_0=cd /`, `ExpectSend_Send_1=pwd` 로 같았다 (Xshell 기본 템플릿). 그대로 가져오면 모든 세션이 `/` 로 이동하므로 가져오지 않았다.
