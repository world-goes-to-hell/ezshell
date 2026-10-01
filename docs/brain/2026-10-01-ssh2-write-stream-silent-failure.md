# ssh2 SFTP 쓰기 스트림은 서버가 WRITE 를 거부해도 error 를 내지 않는다

## 증상
- 서버가 쓰기(WRITE)를 거부한 업로드가 전송 큐에 "완료"로 표시된다.
- 원격 파일은 0바이트(또는 일부만)로 남는다. 앱 어디에도 오류가 보이지 않는다.

## 원인
- ssh2 1.17 의 `sftp.createWriteStream()` 은 WRITE 요청이 실패하면 `error` 이벤트 없이 `close` 만 보낸다.
  (E2E 중 `wstest.cjs` 단독 스크립트로 재현: 출력은 `close` 하나뿐)
- `main.js` 의 `executeUpload` 는 `writeStream.on('close')` 를 성공으로 처리하고 있었다.
- 쓰기용 OPEN 이 거부되는 경우에는 `error` 가 정상적으로 온다. 그래서 OPEN 거부로만 테스트하면 이 문제가 보이지 않는다.

## 해결
- `close` 뒤에 `sftp.stat` 으로 원격 크기를 읽어 로컬 크기와 비교한다 (`src/sftpUploadCheck.js`).
- 일시정지/취소로 스트림을 닫은 경우(`abortController.aborted`)는 검사하지 않는다.
- `close` 시점에 읽기 스트림도 닫는다. 그러지 않으면 닫힌 쓰기 스트림에 계속 쓰려고 한다.

## 함께 기억할 것
- `main.js` 가 `require('./src/xxx.js')` 로 읽는 모듈은 번들되지 않는다. 새 모듈을 만들면 `electron.vite.config.ts` 의 `MAIN_RUNTIME_MODULES` 에 추가해야 패키징된 앱에서 동작한다.
- 테스트 서버에서 실패를 흉내 낼 때는 OPEN 거부와 WRITE 거부를 둘 다 만들어 확인한다.

## 사례
2026-10-01 SFTP 전송 파일 강조 기능의 "실패 표시"를 E2E 로 검증하다 발견했다.
