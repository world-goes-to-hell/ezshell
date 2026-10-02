# dev 렌더러 서버가 5173 을 써서 다른 Vite 프로젝트의 화면을 가로채던 문제

## 증상
- ezShell 을 `npm run dev` 로 띄워 둔 상태에서 다른 프로젝트(Vite, 5173)를 개발하면 `http://localhost:5173` 이 ezShell 화면으로 연결되거나 HMR 연결이 끊겼다.

## 원인
- electron-vite 의 렌더러 dev 서버는 포트를 지정하지 않으면 Vite 기본값인 5173 을 쓴다.
- Vite 는 포트가 사용 중이면 다음 번호로 넘어가지만, Windows 에서는 듣는 주소가 다르면 충돌로 판정하지 않는다. 실측:
  - 다른 프로젝트: `0.0.0.0:5173`, `[::]:5173`
  - ezShell: `[::1]:5173` (`localhost`)
- 두 서버가 같은 번호를 동시에 듣고, 브라우저의 `localhost` 는 `::1` 을 먼저 찾으므로 더 구체적인 주소를 가진 ezShell 쪽으로 연결됐다.

## 수정
- `electron.vite.config.ts` 의 렌더러 설정에 `server.port: 15173` 을 지정했다. Vite 계열 프로젝트가 쓰는 5173~518x 범위와 겹치지 않는다.
- `strictPort` 는 켜지 않았다. dev 앱을 동시에 두 개 띄우는 검증 방식(`docs/brain/2026-09-28-sftp-e2e-without-real-servers.md`)에서 두 번째가 15174 로 넘어가야 하기 때문이다.
- `main.js` 의 예전 실행 경로(`--dev`, `ELECTRON_RENDERER_URL` 없음)가 쓰던 `http://localhost:5173` 세 곳을 상수 `DEV_RENDERER_URL` 하나로 모으고 같은 포트로 맞췄다.

## 검증
- 다른 프로젝트의 Vite(5173)가 떠 있는 상태에서 격리 프로필로 `electron-vite dev` 를 실행했다.
  - electron-vite 가 알려준 주소: `http://localhost:15173/`
  - 듣는 소켓: 다른 프로젝트 `0.0.0.0:5173`, `[::]:5173` / ezShell `[::1]:15173`. ezShell 이 5173 을 듣지 않는다.
  - 앱이 정상적으로 시작됐다 (`ELECTRON_RENDERER_URL` 로 새 포트를 받아서 불러온다).
- 종료한 뒤에는 5173 에 다른 프로젝트만 남았다.

## 참고
- 수정 전에 띄워 둔 dev 앱은 다시 시작해야 새 포트로 옮겨 간다.
