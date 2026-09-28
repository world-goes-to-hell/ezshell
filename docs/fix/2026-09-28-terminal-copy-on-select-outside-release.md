# 터미널 드래그 자동 복사가 동작하지 않을 때가 있음

- 작성일: 2026-09-28

## 증상
터미널에서 드래그로 텍스트를 선택해도 자동 복사(및 "복사됨" 알림)가 되지 않는 경우가 있다.

## 원인
`enableCopyOnSelect` (`lib/terminalClipboard.ts`) 가 **터미널 요소의 `mouseup`** 에서만 복사했다.
줄 끝까지 선택하려고 오른쪽 패널(명령어 기록/서버 모니터링)이나 SFTP 영역까지 끌고 나가 놓으면
`mouseup` 이 다른 요소에서 발생해 복사가 실행되지 않는다. 선택 영역은 남아 있어 "선택은 됐는데 복사가 안 됨" 으로 보인다.

재현: CDP 로 실제 마우스 드래그
- 터미널 안에서 놓음 → 복사됨 (정상)
- 터미널 오른쪽 경계 밖(히스토리 패널 위)에서 놓음 → 선택만 남고 복사/알림 없음

## 수정
- 터미널 요소의 `mousedown`(capture) 에서 드래그 시작을 감지하고, 그 다음 `mouseup` 1회를 **document** 에서 기다린다 (`{ capture: true, once: true }`).
- xterm 이 내부 레이어에서 mousedown 을 처리하므로 버블링이 막혀도 받도록 capture 단계로 등록.
- 정리 함수에서 document 리스너도 제거.
- 메인 터미널, 분할 터미널, 분리 창이 모두 이 함수를 쓰므로 한 번에 적용된다.

## 검증
- `npx tsc --noEmit` exit 0
- 실행 중인 앱에서 터미널 밖에서 놓는 드래그 → "12줄을 클립보드에 복사했습니다" 알림과 클립보드 기록 확인

## 추가: Ctrl+V 로 붙여넣으면 두 번 입력됨 (Shift+Insert 는 한 번)
**원인**: 첫 커밋부터 있던 Ctrl+V 처리기가 붙여넣기를 두 경로로 실행했다.
1. 처리기가 `navigator.clipboard.readText()` 로 읽어 `sshSend` / `sshSplitSend` 로 직접 전송
2. 처리기가 `false` 를 반환하면 xterm 은 키 처리만 건너뛰고 `preventDefault` 는 하지 않는다
   (xterm 5.3 `_keyDown`: `if (customKeyEventHandler(e) === false) return false`).
   그래서 브라우저 기본 동작으로 textarea 에 `paste` 이벤트가 발생하고 xterm 이 한 번 더 입력한다.

Shift+Insert 는 2번 경로만 타서 한 번 들어갔다.

**수정**: 직접 전송(1번)을 삭제하고 `return false` 만 남겨 xterm 의 기본 붙여넣기에 맡긴다.
xterm 경로는 여러 줄의 줄바꿈 변환과 bracketed paste 도 처리하므로 더 정확하다.
판정은 `isPasteShortcut` (`lib/terminalClipboard.ts`) 으로 모으고 `event.code === 'KeyV'` 로 바꿨다.
한글 입력 상태에서는 `event.key` 가 `ㅍ` 이라 기존 `key === 'v'` 판정이 빗나간다.
적용: `TerminalPanel`, `SplitTerminal`.

**검증**: `isPasteShortcut` 단위 테스트 6개, 전체 62개 통과, tsc exit 0.
실제 붙여넣기 확인은 사용자가 앱을 사용 중이라 사용자에게 요청.
