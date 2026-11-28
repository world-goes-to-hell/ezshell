# dev 실행이 설치본의 로컬 셸을 모두 가져가고 끝내던 문제

## 증상

설치본 ezShell 을 쓰는 중에 `npm run dev` 를 띄우면 설치본의 로컬 탭(에이전트 포함)에서 오류가 나고, dev 를 끄면 셸이 모두 꺼졌다 (2026-11-27 사용자 제보). dev 화면에는 `Cannot read properties of undefined (reading 'dimensions')` 가 쏟아졌다.

## 원인

- dev 와 설치본은 같은 데이터 폴더(`%APPDATA%\my-ssh-client`, `src/userDataDir.js`)를 쓴다.
- 세션 보관 프로세스의 파이프 이름과 토큰은 그 폴더의 `session-host.json` 에 있고, 앱은 시작할 때마다 이 파일로 이전 보관 프로세스에 다시 붙어 본다 (`client.js` 의 `reattach`). 업데이트 뒤 새 앱이 셸을 넘겨받는 경로다.
- 보관 프로세스(`host.js`)는 토큰이 맞으면 "가장 새로운 앱"을 받고 이전 연결을 끊었다. 그래서 dev 가 설치본의 보관 프로세스를 차지했고, 설치본은 연결을 잃었다. dev 를 끄면 keep 없이 연결이 끊긴 것이라 보관 프로세스가 셸 트리를 모두 끝냈다.
- dev 를 끌 때 `shutdown()` 이 같은 이름의 상태 파일을 지워, 설치본의 다음 업데이트 인계도 깨질 수 있었다.

## 수정

1. **보관 프로세스 (`host.js`):** 앞 앱이 keep 을 보내지 않고 아직 붙어 있으면, 새 앱을 `busy` 로 거절한다. 업데이트 경로에서는 앞 앱이 keep 을 보낸 뒤라 그대로 넘어간다.
2. **클라이언트 (`client.js`):** 거절된 연결은 바로 실패로 보고(close), 자기 보관 프로세스를 새로 띄운다. 이때 거절된 연결의 hello 대기를 비운다. 남겨 두면 새 보관 프로세스의 hello 를 그 대기가 가로채 시작이 5초 멈췄다 (단위 테스트에서 잡았다). 새 연결에서는 `lost` 를 다시 false 로 둔다.
3. **dev 의 상태 파일 (`main.js`):** 패키징되지 않은 앱은 `session-host-dev.json` 을 쓴다. 설치본의 보관 프로세스는 업데이트 전까지 옛 코드로 돌기 때문에 1번이 바로 듣지 않는다. 3번은 dev 쪽 코드라서 지금 바로 설치본을 지킨다.

## 검증

- `src/sessionHost/host.test.js`·`client.test.js`: 두 번째 앱 거절, keep 뒤 인계, dev 상태 파일 분리 (관련 47개 통과)
- 화면 시험 `local-keep-through-update` 통과 (업데이트 재시작 인계가 그대로 동작)
