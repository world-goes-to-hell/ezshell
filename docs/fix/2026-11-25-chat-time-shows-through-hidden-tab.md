# 채팅 보기: 뒤에 숨은 탭의 시간이 앞 탭 위에 보임

작성: 2026-11-25 (사용자 보고: 빈 칸 한가운데 `오전 11:15` 만 떠 있었다. 2026-11-24 에 고친 "누른 줄의 시간이 남음"과 다른 원인이다)

## 원인
말풍선의 시간(`.agent-chat-timestamp`)은 평소 `visibility: hidden` 이고, 보일 때는 `visibility: visible` 로 바꿨다 (포인터·키보드 포커스가 있는 줄, 카톡 모드에서 1분 안 마지막 보낸 말의 `data-always-visible`).

앞에 있지 않은 탭은 `display: none` 이 아니라 `visibility: hidden` 으로 숨긴다 (`App.tsx` 의 `.terminal-wrapper.hidden`, 탭 내용이 배치를 유지하게). `visibility` 는 자식이 `visible` 로 다시 정하면 부모가 숨겨져 있어도 그 자식만 그려진다. 그래서 뒤에 숨은 탭의 채팅에서 늘 보이게 한 시간만 앞 탭 위에 떠 보였다. 말풍선은 부모를 따라 숨으므로 시간만 남는다.

## 수정
보일 때의 값을 `visibility: inherit` 로 바꿨다 (`AgentChat/AgentChat.css`). 앞 탭에서는 부모가 보이므로 그대로 보이고, 숨은 탭에서는 부모를 따라 숨는다.

앱의 다른 `visibility: visible` 은 탭 내용 밖(사이드바 접힌 띠, 말풍선 도움말)이거나 탭 감싸개 자체(`.terminal-wrapper.visible`), 또는 앞 탭에서만 잠깐 그리는 표시(`.pane-merge-trail`)라 같은 문제가 없다.

## 시험
화면 테스트 `local-agent-chat-timestamps` 에 "a background tab hides its chat times with it" 을 더했다: 카톡 모드에서 늘 보이는 시간이 있는 상태로 그 탭의 감싸개를 숨기면 시간도 숨어야 하고, 되돌리면 다시 보여야 한다. 예전 규칙(`visible`)으로 되돌리면 이 확인이 실패하고(`visible`), 고친 규칙에서 통과하는 것을 둘 다 확인했다.
