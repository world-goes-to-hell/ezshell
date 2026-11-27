# 하위 저장소: Git 로그인이 필요할 때 안내와 `터미널에서 로그인`

2026-11-27 사용자 요청과 승인으로 진행한다. 원격 주소를 `http://speciesgit…` 에서 `https://…` 로 바꾼 뒤 `연결 확인`을 누르자 Git 의 영어 오류("could not read Username … terminal prompts disabled")가 그대로 보였다.

## 원인

- 서버는 HTTPS 로 401(로그인 필요)을 돌려준다. 인증서 확인도 통과했다.
- Windows 자격 증명 관리자에는 `git:http://speciesgit.coreit.co.kr` 만 저장돼 있다. Git 자격 증명 관리자는 프로토콜과 호스트를 키로 쓰므로, https 주소에서는 이 정보를 쓰지 못한다.
- 앱은 Git 을 `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` 로 실행한다(`nestedGit.js`). 백그라운드 작업이 로그인 창을 띄우고 멈추지 않게 하려는 것이다. 이 설정은 유지한다.

## 진행 상황

- [x] main(`nestedRepositories.js` 의 `messageOf`): 로그인 실패 오류를 `Git 로그인이 필요합니다.` 로 시작하는 한국어 안내로 바꾼다. 대상 오류는 `could not read Username/Password`, `terminal prompts disabled`, `Authentication failed`, `HTTP Basic: Access denied` 다. 가져오기 실패, 받기 실패, 원격 대화상자가 모두 이 함수를 지난다.
- [x] 화면(`lib/gitLogin.ts`): `needsGitLogin(message)` 와 `gitLoginCommand(target?)` 를 둔다. 명령은 `git ls-remote --heads [-- 대상]` 이다. 대상은 원격 이름이나, 따옴표·공백·셸 기호가 없는 `https://` 주소만 받는다. 그래서 따로 인용하지 않아도 셸에 그대로 넣을 수 있다. 맞지 않으면 버튼을 보이지 않는다.
- [x] 화면: 원격 대화상자의 안내 줄, 하위 저장소 줄의 받기 실패와 가져오기 실패 표시에 `터미널에서 로그인` 버튼을 둔다. 누르면 그 저장소 폴더에서 로컬 터미널을 열고, 첫 출력이 멈춘 뒤 명령을 입력해 둔다. Enter 는 보내지 않는다. 대화상자는 닫는다.
- [x] 단위 시험(main 의 오류 분류, 화면의 명령 생성), 화면 시험(`local-nested-repos`)

## 바꾸지 않는 것

- 앱이 비밀번호를 받거나 대신 로그인하지 않는다. 로그인은 사용자가 터미널에서 Git 자격 증명 관리자의 창으로 한다.
- 입력은 본창이 직접 연 셸에만 한다(기존 `localShellWrite`). MCP 나 휴대폰 경로는 건드리지 않는다.

## 검증 (2026-11-27)

- 단위 시험: `nestedRepositories.test.js` 21개(실제 화면의 GCM 오류 문구 포함), `gitLogin.test.ts` 7개가 통과했다.
- 화면 시험 `local-nested-repos` 가 ALL PASSED 였다. 401 을 돌려주는 시험용 HTTPS 서버로 실제 Git 의 오류를 받아 다음을 확인했다.
  - 한국어 안내와 버튼이 나온다.
  - 버튼을 누르면 대화상자가 닫히고, 새 터미널이 그 저장소 폴더에서 열려 명령이 입력된다.
  - 명령은 실행되지 않는다. 버튼을 누른 뒤 서버 요청 수가 늘지 않았다.
- 타입 검사에서 오류가 없었고 빌드도 성공했다.

## 추가로 알게 된 것 (2026-11-27)

- 사용자의 `~/.gitconfig` 에는 `credential.http://speciesgit.coreit.co.kr.provider generic` 만 있다. https 주소에는 이 설정이 없어서, GCM 2.5 가 서버의 `WWW-Authenticate: Basic realm="GitLab"` 을 보고 GitLab 방식을 고른다. 그러다 사내 GitLab 의 OAuth 설정이 없다는 경고를 낸다(`GCM_TRACE=1` 로 확인). 사용자가 터미널에서 직접 `git ls-remote` 를 실행해도 로그인되지 않았다고 했다. https 주소에도 `provider generic` 을 주면, http 주소에서 쓰던 아이디·비밀번호 창을 쓰게 된다.
- 화면 시험이 사용자 전역 설정을 바꾼 일이 있었다. GCM 은 새 호스트를 판별한 결과를 전역 설정에 `credential.https://127.0.0.1:<포트>.provider` 로 적는다. 그래서 시험 서버로 실행할 때마다 한 줄씩, 모두 5줄이 남았고 지웠다. 시험 저장소의 로컬 설정에 `credential.provider generic` 을 넣으면 판별도, 전역 기록도 일어나지 않는다. 다시 돌려 전역 설정이 그대로인 것을 확인했다.
