# 오래된 서버 접속 실패: "Handshake failed: no matching key exchange algorithm"

- 날짜: 2026-11-04

## 증상
PuTTY 로는 접속되는 서버가 ezShell 에서는 `Handshake failed: no matching key exchange algorithm` 으로 접속되지 않았다.

## 원인
ssh2 1.17 은 오래된 방식을 지원은 하지만 기본 목록에서 뺀다.
- 키 교환: `diffie-hellman-group14-sha1`, `diffie-hellman-group-exchange-sha1`, `diffie-hellman-group1-sha1`
- 호스트 키: `ssh-dss`
- 암호: `aes128-cbc`, `aes192-cbc`, `aes256-cbc`, `3des-cbc`
- MAC: `hmac-sha1-96`, `hmac-md5`, `hmac-md5-96`

CentOS 5·6 시절 OpenSSH, 오래된 네트워크 장비, 일부 상용 SSH 서버는 이것만 지원한다. PuTTY 는 이 방식들을 여전히 쓴다 (일부는 경고와 함께).

## 수정
`src/sshAlgorithms.js` 의 `SSH_ALGORITHMS` 를 모든 ssh2 연결(터미널, 점프 호스트, 자동 재연결, 연결 테스트, MCP)의 `algorithms` 로 넘긴다. ssh2 의 `{ append: [...] }` 형식이라 기본 목록은 그대로 두고 위 방식들을 **맨 뒤(가장 낮은 우선순위)** 에 붙인다. 지금 런타임(Electron 의 BoringSSL)이 지원하지 않는 방식은 빼고 붙인다 (지원하지 않는 이름을 넘기면 ssh2 가 접속 전에 예외를 던진다).

## 왜 이렇게 했나 (보안)
- 협상은 클라이언트 목록 순서를 따른다. 새 방식을 지원하는 서버는 지금과 똑같이 새 방식으로 접속한다. 오래된 방식은 서버가 그것만 지원할 때만 쓰인다 (PuTTY 와 같은 수준).
- 중간에서 서버의 목록을 고쳐 약한 방식을 강요하는 공격: 양쪽 KEXINIT 은 서버가 서명하는 교환 해시에 들어가고, 앱은 호스트 키를 검증한다 (`src/hostKeys`). 목록이 바뀌면 서명 검증이 실패해 접속되지 않는다.
- 세션마다 켜는 설정으로 두지 않았다. 사용자는 "PuTTY 로 되는데 안 된다" 만 알 수 있고 어떤 설정을 켜야 하는지 알 수 없다.
- 남은 위험: 오래된 방식만 지원하는 서버와의 연결은 그 방식만큼 약하다 (예: group1 은 1024비트). 서버를 바꾸지 않는 한 PuTTY 를 써도 같다.
