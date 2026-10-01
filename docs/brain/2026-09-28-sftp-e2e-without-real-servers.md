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

## 추가 (2026-10-01): 가려진 창 문제의 근본 해결
- 검증용 앱을 아래처럼 Chromium 옵션과 함께 띄우면, 다른 창에 가려져도 `visibilityState` 가 `visible` 로 유지된다.
  화면 갱신(rAF)이 계속 돌아서 xterm 글자가 DOM 에 그려지고, `Page.captureScreenshot` 도 멈추지 않는다.

      npx electron-vite dev -- --remote-debugging-port=9333 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling

- 이 옵션 없이 가려진 창에서는 xterm 의 `.xterm-rows` 가 비어 있어 "터미널 내용이 사라졌다" 로 오진하기 쉽다.
- xterm 에 글자를 넣을 때: `.xterm-helper-textarea` 에 value 를 넣고 `InputEvent('input', { inputType: 'insertText', data })` 를 보내면 onData 가 호출된다.

## 추가 (2026-10-01): 페이지에서 스토어를 가져올 때 다른 인스턴스를 잡는 문제
- 검증 스크립트가 `await import('/stores/terminalStore.ts')` 로 zustand 스토어를 가져오면 처음에는 앱과 같은 인스턴스다.
- dev 서버가 떠 있는 동안 그 파일이 한 번이라도 수정되면, 앱은 `terminalStore.ts?t=<시각>` 주소로 불러온다 (페이지를 새로 고쳐도 유지됨).
  이때 쿼리 없는 주소로 import 하면 **별도 인스턴스**가 만들어져서 `terminals.size` 가 항상 0 으로 보인다. 연결은 실제로 되는데 "연결이 안 된다" 로 오진하기 쉽다.
- 해결: 앱이 실제로 불러온 주소를 찾아서 import 한다.

      import(performance.getEntriesByType('resource').map(r => r.name).filter(n => n.includes('/stores/terminalStore.ts'))[0])

- 여러 세션이 같은 작업 폴더에서 dev 앱을 동시에 띄울 때는 포트를 나눈다 (CDP 9333/9444, 임시 SSH 2222/2233, 렌더러 5173/5174). `--user-data-dir` 도 각자 따로 둔다.
