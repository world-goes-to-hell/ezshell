# 하위 Git 저장소의 원격 주소 관리

상태: 완료 (2026-11-27)

## 배경

ktsn-service 의 원격이 `http://speciesgit.coreit.co.kr/...` 라서 받기가 "실패 · Git 원격 저장소는 HTTPS, SSH 또는 이 PC의 경로만 사용할 수 있습니다." 로 끝난다. 앱은 암호화하지 않는 `http://` 를 일부러 막는다 (`src/ipc/nestedGit.js` `checkRemote`). 사용자가 원격 주소를 앱 안에서 보고 바꿀 수 있어야 한다.

## 정한 설계

1. **들어가는 곳**
   - 하위 저장소 메뉴(⋯)에 `원격 주소…` 를 더한다.
   - 받기·가져오기가 이 주소 문제로 실패한 줄에는 `원격 주소 바꾸기` 단추를 같이 보인다.
2. **대화 상자** (`NestedRepositoryRemoteDialog.tsx`, 브랜치 대화 상자와 같은 모양)
   - 원격마다 이름과 주소를 보인다. 푸시 주소가 따로 있으면 그것도 보인다.
   - 받을 수 없는 주소(`http://` 등)에는 이유를 붙이고, `http://` 이면 `HTTPS 로 바꾸기` 를 바로 누를 수 있게 한다 (주소 앞부분만 바꿔 입력칸에 채운다).
   - 주소 바꾸기, 원격 추가, 원격 삭제(확인 후)를 한다. 이름 바꾸기는 하지 않는다.
   - `연결 확인` 단추: 저장 전에 새 주소로 `git ls-remote --heads` 를 돌려 서버가 그 주소로 응답하는지 본다. 사내 서버가 HTTPS 를 지원하는지 여기서 바로 알 수 있다.
3. **main 검사** (`local-nested-repository-remotes`, `…-set-remote`, `…-remove-remote`, `…-test-remote`)
   - 기존 `handle` (본창 주 프레임·잠금 해제 확인)과 `branchRoot` 로 저장소 경로를 검증한다.
   - 원격 이름: `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`.
   - 주소: 저장 전에 `checkRemote` 를 그대로 거친다. 그래서 앱으로는 `http://` 주소를 새로 넣을 수 없다 (암호화 정책은 그대로 유지).
   - 비밀번호가 든 주소(`https://user:pass@...`)는 거절한다. Git 설정 파일에 평문으로 남기 때문이다. 아이디만 든 주소는 허용한다.
   - 화면에 보낼 때도 주소의 비밀번호 부분은 가린다 (이미 그렇게 저장된 저장소 대비).
   - 위험한 저장소 설정(`riskyKeys`)이 있으면 받기처럼 먼저 확인을 받는다.
   - 실행은 `git remote set-url|add|remove -- <이름> <주소>` 로, 인자 앞에 `--` 를 둔다.
   - 연결 확인은 받기와 같은 네트워크 환경(`network: true`, 같은 프로토콜 제한)과 시간 제한을 쓴다.
4. **바뀐 뒤**: 상태를 다시 읽고 실패 표시를 지운다. 이 저장소의 설정 지문이 바뀌므로 진행 중이던 받기는 "설정이 바뀌었습니다" 로 멈춘다 (기존 동작).

## 하지 않는 것

- `http://` 허용. 사내 서버가 HTTPS 를 지원하지 않는다고 확인되면 따로 정한다.
- 로컬 작업 자체(최상위 저장소)의 원격 관리. 필요하면 같은 대화 상자를 이어 붙인다.
- `url.<base>.insteadOf` 같은 주소 바꿔 쓰기 설정 편집. 보이는 주소는 `remote.<이름>.url` 에 적힌 값이다.

## 파일

- `src/ipc/nestedRepositories.js`, `src/ipc/nestedGit.js` (원격 읽기·쓰기·확인, 주소 가리기)
- `src/preload.js`, `src/renderer/types/index.ts`
- `src/renderer/components/Sidebar/NestedRepositories.tsx`, 새 `NestedRepositoryRemoteDialog.tsx`, `NestedRepositories.css`
- `src/ipc/nestedRepositories.test.js` (이름·주소 검사, 비밀번호 거절, 가리기, 명령 인자)
- `e2e/specs/local-nested-repos.js` (http 원격 → HTTPS 로 바꾸기 → 저장 → 받기 실패 표시가 사라짐)
- `docs/architecture/sidebar.md`

## 진행

- [x] main 원격 읽기·쓰기·확인 + 단위 시험
- [x] 대화 상자와 메뉴·실패 줄 단추
- [x] 화면 시험, 문서
