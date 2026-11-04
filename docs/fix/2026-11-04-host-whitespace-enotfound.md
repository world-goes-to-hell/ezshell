# IP 로 저장한 서버가 "getaddrinfo ENOTFOUND 203.227.160.8" 로 접속되지 않음

- 날짜: 2026-11-04

## 증상
터미널 연결 때 `Error invoking remote method 'ssh-connect': Error: getaddrinfo ENOTFOUND 203.227.160.8` 토스트가 뜨고 접속되지 않았다. 주소는 IP 인데 이름 조회(DNS) 실패가 났다.

## 원인
세션의 호스트 앞뒤에 공백이나 줄바꿈이 들어가 있으면 ssh2 는 그 값을 IP 로 보지 않고 이름으로 조회해 `ENOTFOUND` 를 낸다 (뒤 공백, 앞 공백, 줄바꿈 모두 같은 오류로 재현함). 화면에는 공백이 보이지 않아 IP 그대로처럼 보인다.
연결 테스트와 MCP(`buildOptions`)는 호스트를 `trim()` 했지만, 터미널 연결(`main.js` 의 `openShellConnection`, 점프 호스트, 자동 재연결)은 저장된 값을 그대로 썼다.

또 이 경로의 오류는 `ssh-connect` 가 그대로 던져서 Electron 의 영어 원문("Error invoking remote method ...")이 사용자에게 보였다.

## 수정
- `sshConnectionTest.js` 의 `normalizeConnectConfig`: 호스트·사용자명·점프 호스트·점프 사용자명 앞뒤 공백과 줄바꿈을 없앤 사본을 만든다 (비밀번호는 공백이 들어갈 수 있어 건드리지 않는다). `ssh-connect` 가 처음에 적용하고, `connectionStates` 에 이 값이 남아 자동 재연결과 재연결 버튼도 같은 값을 쓴다.
- `ssh-connect` 의 호스트 키 외 오류는 연결 테스트와 같은 `describeSshError` 로 한국어 문구와 안내를 돌려준다 (예: "호스트를 찾을 수 없습니다. 호스트 주소(도메인)를 확인하세요."). 토스트 제목도 "연결 실패" 로 바꿨다.

## 왜 이렇게 했나
저장된 세션을 고치게 하는 대신 연결할 때 정리한다. 이미 저장된 세션이 그대로 동작하고, 세션 파일은 암호화되어 있어 일괄 수정이 번거롭다. 호스트 키도 정리한 호스트로 기록되어 연결 테스트·MCP 와 같은 키를 쓴다.
