# 구버전 Antigravity CLI 실행

Antigravity CLI 1.4.4에서 ezShell이 채팅 보기용 `--settings`를 붙이면 CLI가 `flags provided but not defined: -settings`를 출력하고 종료한다. 이 옵션은 1.5.16의 도움말에 나온다. `agy --settings x --version`은 1.4.4에서도 버전을 먼저 출력하고 성공하므로 옵션 지원을 확인하는 데 쓸 수 없다.

Windows PowerShell에서 직접 입력한 `agy`와 앱의 Windows·Unix 관리 실행은 `agy --help`에서 `--settings` 옵션을 확인한다. 지원 버전에는 기존 세션 설정과 OSC 환경 변수를 적용한다. 구버전은 셸마다 흐리게 안내를 한 번 표시하고 사용자가 입력한 인자 그대로 실행한다. 명시적으로 `--settings`를 지정하거나 업데이트·도움말 등 기존 예외에 해당하면 사용자 입력을 그대로 실행한다.

PowerShell은 실행 파일의 경로, 크기, 수정 시각이 같은 동안 확인 결과를 재사용한다. CLI가 교체되면 같은 셸에서 다음 실행 시 다시 확인한다. Unix 관리 실행은 셸마다 `agy`를 한 번 확인하고 실행한다.

`src/localShell.test.js`는 이름이 비슷한 `--settings-file`과 실제 옵션을 구분하고, PowerShell에서 구버전 인자 전달과 업데이트 뒤 재확인을 검증한다. `local-agent-chat-antigravity` 화면 테스트는 구·신버전의 관리 실행과 PowerShell 직접 입력을 검증한다.
