# 사내 서버 없이 SFTP 화면을 끝까지 검증하는 방법

## 문제
세션 목록이 전부 사내 개발/운영 서버라서, SFTP 패널 기능(이름 바꾸기, 삭제 등)을 실제 화면에서 확인하려면 그 서버에 쓰기 작업을 해야 했다. 그래서 검증을 건너뛰고 사용자에게 넘기는 일이 반복되었다.

## 해결: 임시 SSH/SFTP 서버 + CDP
1. `ssh2` 의 `Server` 로 임시 폴더를 루트로 하는 서버를 띄운다 (비밀번호 `test`, 포트 2222).
   - 앱이 쓰는 요청만 구현하면 된다: `REALPATH`, `STAT/LSTAT`, `OPENDIR`, `READDIR`, `CLOSE`, `RENAME`, `MKDIR`, `RMDIR`, `REMOVE`.
   - 셸도 받아 줘야 앱의 `ssh-connect`(conn.shell)가 성공한다: `pty`, `shell` 이벤트를 accept.
   - SFTP v3 의미대로 `RENAME` 은 대상이 있으면 `FAILURE` 를 돌려준다.
2. 앱은 `npx electron-vite dev -- --remote-debugging-port=9333` 으로 띄운다.
3. "새 연결" 모달에서 `127.0.0.1:2222`, "이 연결 정보 저장" 해제 후 연결 → `Ctrl+Shift+S` 로 SFTP 열기.
4. 입력은 `Input.dispatchKeyEvent`(rawKeyDown/keyUp, `code` 포함)와 `Input.dispatchMouseEvent` 로 보내고, 결과는 DOM 과 실제 디스크 양쪽으로 확인한다.

## 함정
- 창이 최소화(`visibilityState: hidden`)되어 있으면 CDP 입력이 전달되지 않는다.
- `confirm()` 이 뜨면 렌더러가 멈춰서 `Input.dispatchKeyEvent` 응답도 오지 않는다. 키 전송을 await 하지 말고 `Page.enable` 후 `Page.handleJavaScriptDialog({accept:true})` 를 폴링한다.
- Bash 도구의 heredoc 에서 `\\` 가 `\` 로 줄어드는 경우가 있다. 백슬래시가 들어간 스크립트/테스트는 Write 도구로 쓴다.
- 백그라운드 `npx electron-vite dev` 를 TaskStop 해도 electron.exe 는 남는다. 명령줄에 `--remote-debugging-port=9333` 이 있는 PID 를 찾아 `taskkill /T /F` 로 정리한다 (사용자가 띄운 다른 인스턴스를 죽이지 않도록 명령줄로 구분).
- 한글 IME 상태에서는 `e.key` 가 `ㅜ`, `ㅣ` 처럼 들어올 수 있다. 글자 단축키는 `e.code`(`KeyN`)로 비교한다.

## 사례
2026-09-28 SFTP Windows 단축키 작업. 스크립트는 세션 scratchpad 의 `sftp-server.cjs`, `cdplib.mjs`, `scenario.mjs` 에 있었다 (임시). 25개 시나리오 모두 통과.

## 추가 (2026-09-29): 창이 가려져 있을 때
- 최소화가 아니어도 다른 창에 완전히 가려지면 Chromium이 `visibilityState: hidden`으로 판단하고, CDP `Input.*` 이벤트가 먹지 않는다.
  `Page.bringToFront`, `ShowWindow`/`SetForegroundWindow`로도 풀리지 않았다(Windows가 포커스 탈취를 막음).
- 이때는 입력 이벤트 대신 DOM 이벤트를 직접 보낸다.
  - 입력 값: `HTMLInputElement.prototype`의 `value` setter 호출 후 `input` 이벤트 dispatch (React가 인식함)
  - Radix DropdownMenu 트리거: `pointerdown`(button 0, pointerType mouse)을 보내야 열린다. `click()`만으로는 안 열린다.
  - 탭 드래그 팝아웃: `dragstart`(DataTransfer 포함) → `.terminal-area`에 창 밖 좌표의 `dragleave` → `dragend`
- 스크립트: 세션 scratchpad의 `popout-dom.mjs`, `picker-dom.mjs` (임시)
- 창이 가려진 상태에서는 `Page.captureScreenshot`도 응답이 오지 않고 멈춘다(새 프레임이 그려지지 않음). DOM 검사로 판정하고, 스크린샷 단계에는 타임아웃을 건다.
- 심볼릭 링크 검증: Windows에서는 `fs.symlinkSync(target, path, 'junction')`로 관리자 권한 없이 디렉토리 링크(대상이 없는 깨진 링크 포함)를 만들 수 있다.
  임시 서버는 `READDIR` attrs를 `lstat`으로, `LSTAT`/`READLINK` 핸들러를 따로 두어야 실제 서버처럼 동작한다.
