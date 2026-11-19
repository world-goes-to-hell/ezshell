# 설정 파일 자리 표시(`${NAME}`)의 정의 찾기 (2026-11-19)

## 요청

yml·properties 의 `${UPLOAD_DIR:./uploads}` 같은 자리 표시가 어디서 값을 가져오는지 보고 싶다. 여러 파일에 있으면 목록으로, 고르면 그 파일을 열고 그 줄을 강조.

## 결정

- 파일 창 편집기(로컬·서버 파일 모두)에서 `${이름}` / `${이름:기본값}` 에 밑줄. `Ctrl+클릭`(또는 포인터를 올려 나온 안내)으로 정의를 찾는다. 정의가 하나면 바로 열고, 여럿이면 목록(파일, 줄, 그 줄의 글자). 기본값은 목록 맨 위에 "정의가 없을 때 쓰는 값".
- 찾는 곳: `.env*`, `docker-compose*.yml`·`compose*.yml`, `Dockerfile*`, `*.yml`/`*.yaml`(키 경로, compose 의 `environment`), `*.properties`, `*.sh`, `*.service`. 이름이 `app.upload.dir` 처럼 점으로 되어 있으면 yml 들여쓰기 경로까지 따라간다. Spring 의 느슨한 이름 맞춤(`UPLOAD_DIR` ↔ `upload.dir`)도 본다 (대소문자·`.`·`_`·`-` 무시). 주석 줄과 `${...}` 안에서만 나온 이름은 정의가 아니다.
- 범위: 로컬 파일은 그 파일을 연 작업 폴더(`doc.local.root`) 전체를 걷는다 (`node_modules`·`.git`·`build`·`dist`·`out`·`target` 등 건너뜀, 깊이 8, 후보 파일 1,500개, 파일당 512KB). 서버 파일은 같은 폴더와 위로 3단계 폴더에서 후보 이름의 파일만 SFTP 로 읽는다 (폴더당 500개, 파일 40개, 파일당 256KB). 서버에 명령을 보내지 않는다.
- 보안: 창은 이름만 보내고, 결과는 key 로만 열 수 있다 (main 이 마지막 결과의 key → 경로를 들고 있다: 창이 임의 경로를 열게 하지 않는다). 로컬은 작업 폴더 밖·링크를 따라가지 않는다.
- 줄로 열기: 새로 여는 창은 `load` 답에 `revealLine` 을 실어, 이미 열린 창은 `remote-file-reveal-line` 으로 알린다. 편집기는 그 줄로 가서 잠깐 강조한다.

## 진행

- [x] main: `src/remoteFiles/configRefs.js`(+test), documents.js 의 `findDefinitions`/`openDefinition`, ipc 두 채널, preload·types
- [x] 화면: CodeEditor 의 자리 표시 밑줄·Ctrl+클릭, 목록 팝업, 줄 강조
- [x] 화면 테스트 `local-config-definitions` (11개). 서버 파일 쪽은 단위 테스트(`searchRemote`, SFTP 흉내)로만 확인했다.
