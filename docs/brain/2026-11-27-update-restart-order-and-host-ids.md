# 업데이트 재시작의 종료 순서와 세션 보관 프로세스의 셸 id

실행 구성 서버를 업데이트 너머로 넘길 때 바로 보이지 않았던 두 가지.

## 1. before-quit 가 keep 보다 먼저 돈다

`install-update` → `app.quit()` → **before-quit** (여기서 `drainDevelopmentTasks` 가 모든 개발 서버를 끈다) → 창 닫힘 → **will-quit** → `finishQuit` → `installAfterShutdown` 에서 비로소 `keepSessionsForUpdate`(host 에 keep).
keep 을 보낸 뒤에 무엇을 넘길지 정하면 이미 늦다. before-quit 에서 `updates.js` 의 `isRestartingForUpdate()`(업데이트 준비됨 + 사용자가 재시작 누름)로 판단해야 한다.

## 2. 보관 프로세스는 끝난 셸의 id 를 계속 쥐고 있다

`host.js` 의 `spawnShell` 은 `shells.has(id)` 면 `spawn-error` 를 돌려준다. 끝난 셸도 `forget` 을 받기 전까지 남는다.
실행 구성은 재기동할 때 같은 셸 id(같은 탭)로 새 PTY 를 여는데, 이 거절이 클라이언트에서 `exit(-1)` 로 보여 "재기동하자마자 crashed, 종료 코드 -1" 이 되었다. 단위 시험의 가짜 host 는 id 중복을 검사하지 않아 화면 시험에서야 드러났다.
→ 보관 프로세스의 PTY 가 끝나면 `host.forget(id)` 를 보낸다 (`localShell.js` 의 `launchProcess` → `onExit`).

## 3. 임시 폴더 이름의 PID 는 앱의 PID 다

Tomcat base(`run-<앱 PID>-…`), Maven 설정, 이클립스 클래스 폴더는 **앱** PID 로 이름이 붙고, 시작 회수와 Tomcat 실행 전 정리가 "그 PID 가 끝났으면" 지운다. 업데이트 뒤 새 앱은 옛 앱의 살아 있는 Tomcat 폴더를 지울 수 있었다.
→ 넘겨받은 실행이 끝날 때까지 옛 PID 를 보호(`protectScratchOwner`)하고, 시작 회수는 보관 프로세스 시작(이어받기 등록)을 기다린다.
