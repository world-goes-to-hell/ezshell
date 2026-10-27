# 터미널 연결 끊김 표시와 재연결 / 종료

- 날짜: 2026-10-27
- 상태: 구현 완료

## 문제

열어 둔 탭의 연결이 끊기면 터미널이 그대로 멈춰 있다. 끊겼는지 알 수 없고, 다시 연결할 방법도 없다 (탭을 닫고 새로 접속해야 한다).

지금 동작:
- main 은 keepalive(30초, 3번)로 끊김을 알아채고, 자동 재연결을 켠 세션은 최대 5번 다시 접속한다 (`attemptReconnect`). 끝내 실패하면 `ssh-reconnect-failed`, `ssh-closed` 를 보낸다.
- 렌더러는 이 신호에서 탭의 `connected` 만 false 로 바꾼다. 화면에 보이는 것은 사이드바 배지 색뿐이다.
- 자동 재연결(`reconnectOnce`)은 점프 호스트 설정을 무시하고 대상 서버에 바로 접속한다 (기존 문제).

## 결정 사항

1. 탭의 연결이 끊기면(`connected: false`) 터미널 영역 전체(분할 셸 포함)를 흐리게 하고, 가운데에 "연결 끊김" 아이콘과 상태, "재연결" / "종료" 버튼을 띄운다 (`ConnectionLostOverlay.tsx`).
   - 자동 재연결 중: "자동으로 다시 연결하는 중입니다 (2/5)". 이때도 두 버튼을 쓸 수 있다.
   - 자동 재연결 실패: main 이 보낸 이유를 보여 준다 (영문 "Maximum reconnection attempts reached" 는 한국어로 바꾼다).
   - 재연결 버튼으로 다시 접속하는 중: "다시 연결하는 중입니다" 와 함께 버튼을 막는다.
   - 화면 문구 계산은 `lib/connectionLost.ts` 의 `describeConnectionLost` 에 두고 테스트한다.
2. "재연결" 은 새 IPC `ssh-reconnect-now` 로 main 이 탭을 처음 열 때와 같은 경로(`openShellConnection`)로 다시 접속한다. 그래서 점프 호스트도 지나고, 호스트 키가 바뀌었으면 확인 창을 띄운다(사람이 누른 것이므로). 탭의 세션 ID 는 그대로라 같은 터미널에 이어서 출력된다.
   - 진행 중인 자동 재연결은 멈춘다 (상태를 `connecting` 으로 바꾸면 대기 중인 시도가 스스로 그만둔다).
   - 옛 연결은 먼저 목록에서 떼고 닫는다. 옛 셸의 `close` 이벤트가 늦게 와도 지금 연결이 아니면 무시하도록, 두 연결 함수의 `stream.on('close')` 에 "지금 연결인지" 확인을 넣는다 (없으면 새 연결을 끊김으로 표시하거나 자동 재연결을 또 시작한다).
   - 실패하면 `describeSshError` 로 한국어 이유를 돌려주고, 접속 정보는 남겨 둬서 다시 누를 수 있게 한다.
3. "종료" 는 탭의 × 와 같다 (`onClose`).
4. 다시 연결되면(`connected` 가 true 로 바뀌면) 터미널 크기를 서버에 다시 보낸다. 새 셸은 80x24 로 열리므로, 지금은 자동 재연결 뒤에도 크기가 맞지 않았다.
5. 확인 창은 키보드 포커스를 가져오지 않는다 (치던 키가 버튼을 누르지 않게). 클릭으로 고른다.
6. 분리한 터미널 창(`TerminalWindow`)에도 같은 카드를 띄운다. 터미널 스토어가 없으므로 연결 이벤트를 직접 듣고, 상태 계산(`linkConnected` 등)은 스토어와 같은 함수를 쓴다. 종료는 연결을 끊고 창을 닫는다. 이를 위해 preload 의 `onSshReconnecting`/`onSshReconnected`/`onSshReconnectFailed` 가 해제 함수를 돌려주게 했다.
7. 이번 범위에 넣지 않은 것: 분할 셸의 자동 복구, 끊김을 더 빨리 알아채기(keepalive 간격 조정), 자동 재연결의 점프 호스트 문제(재연결 버튼은 점프 호스트를 지난다).

## 작업

- [x] `describeConnectionLost` 테스트와 구현
- [x] `terminalStore` 의 `setReconnecting`, `setDisconnected(note)`, `setConnected` 테스트와 구현
- [x] main: `ssh-reconnect-now`, 옛 연결의 늦은 close 무시, 실패 문구 한국어
- [x] preload, 타입, App 의 이벤트 연결
- [x] `ConnectionLostOverlay.tsx`, `TerminalPanel` 의 흐림 처리와 다시 연결된 뒤 크기 보내기
- [x] 분리한 터미널 창에도 적용
- [ ] 실제 서버로 끊김·재연결 확인 (사용자 확인 필요)
