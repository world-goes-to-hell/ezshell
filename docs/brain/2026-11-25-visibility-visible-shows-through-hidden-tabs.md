# `visibility: visible` 은 숨은 탭을 뚫고 보인다

작성: 2026-11-25

## 무엇이 어려웠나
채팅 시간이 엉뚱한 곳에 떠 있다는 보고가 두 번 왔다. 첫 번째(2026-11-24)는 마우스로 누른 버튼에 포커스가 남아 `:focus-within` 이 시간을 계속 보이게 한 것이었고, 그것을 고친 뒤에도 같은 모양의 보고가 다시 왔다. 두 번째는 원인이 달랐다: 빈 칸(다른 탭이 앞에 있는 자리) 한가운데 시간만 떠 있었다. 화면만 보면 같은 버그처럼 보여서 처음 고친 것이 덜 고쳐진 것으로 오해하기 쉽다.

## 원리
- 이 앱은 앞에 있지 않은 탭을 `display: none` 이 아니라 `visibility: hidden` 으로 숨긴다 (`.terminal-wrapper.hidden`, CLAUDE.md "명세를 쓸 때" 참고).
- `visibility` 는 상속되지만 자식이 `visible` 로 다시 정할 수 있다. 그러면 부모가 숨겨져 있어도 그 자식은 그려진다 (`display: none`, `opacity: 0` 과 다른 점).
- 그래서 탭 내용 안에서 "평소 숨김, 조건이 되면 `visibility: visible`" 로 쓴 요소는 뒤에 숨은 탭에서도 조건이 맞으면 앞 탭 위에 나타난다.

## 어떻게 쓰나
- 탭 내용 안에서 숨김을 풀 때는 `visibility: inherit` 를 쓴다 (또는 `opacity` 로 감춘다).
- 화면에 말풍선·카드 없이 작은 글자 하나만 엉뚱한 곳에 떠 있으면, 먼저 뒤에 숨은 탭의 요소인지 의심한다 (`getComputedStyle(el).visibility` 와 가장 가까운 `.terminal-wrapper` 의 클래스).
- 관련 수정: `docs/fix/2026-11-24-chat-time-stuck-after-click.md`, `docs/fix/2026-11-25-chat-time-shows-through-hidden-tab.md`.
