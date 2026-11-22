# 채팅 테마별 모션·포커스·색 다시 정하기

상태: 완료 (2026-11-22)
규모: 중간 (화면·CSS, 보안 경계 없음)

## 문제 (2026-11-22 조사)

채팅 테마(`themes/chatThemes.ts` 의 `chatAppearance`)는 색 변수를 채팅 덮개(`.agent-chat-cover`)와 사용량 줄에만 덮어쓴다.
칸 자체(`.local-terminal-pane`)에는 `--chat-pane-accent` 하나만 준다. 그래서 칸에서 그리는 효과가 앱 테마를 따른다.

| 효과 | 지금 쓰는 값 | 결과 |
|---|---|---|
| 작업 중 테두리를 도는 빛 (`agent-work-trace.css`) | 루트의 `--motion-accent`(앱 강조색) 72% + 앱 `--terminal-foreground` | 앱이 어두운 테마이고 채팅이 카톡 모드이면 캔버스 대비 1.2:1 로 거의 보이지 않는다 |
| 포커스 없는 작업 중 칸의 1px 테두리 | 앱 `--border` | 채팅 캔버스와 무관한 색 |
| 포커스 테두리 2px | 채팅 테마 `accent` | 카톡 모드는 갈색(`#765312`)이라 노란·하늘색 테마와 어울리지 않는다 |
| 잠든 에이전트 덮개 (`AgentSleepCover`) | 앱 테마 전부 | 채팅 위에 앱 테마 색 화면이 덮인다 |
| `--on-accent` (깨우기 버튼 글자) | 앱 값 | 미드나잇처럼 밝은 강조색에서 흰 글자가 될 수 있다 |
| 슬래시 메뉴·화면 복귀 띠 그림자 | `rgba(0,0,0,.3)` 고정 | 밝은 테마에서 그림자가 지나치게 진하다 |

테마의 테두리 색은 캔버스 대비 1.3~1.8:1 이라, 테두리만으로 상태를 보여 주는 것은 원래 약하다.

## 설계

1. 테마 값을 칸에 준다: `LocalTerminalTab` 이 채팅 보기일 때 `chatTheme.style` 을 칸(`.local-terminal-pane`)에 건다. 덮개·사용량 줄·잠든 덮개·띠는 상속받는다. 포털로 그리는 메뉴(`menuStyle`)는 지금처럼 따로 넘긴다.
2. 채팅 프리셋에 모션 값 세 가지를 더한다 (`ChatPreset.motion`):
   - `focus`: 칸 포커스 테두리, 입력칸 포커스, `:focus-visible` 외곽선. 캔버스 대비 3:1 이상.
   - `trace`: 작업 중 테두리를 도는 빛과 포커스 없는 작업 중 테두리. 캔버스 대비 3:1 이상.
   - `working`: 스피너, `작업 중` 상태 글자, 답변 생성 중 아이콘. 바탕 대비 4.5:1 이상 (글자와 함께 쓰임).
3. `chatAppearance` 가 변수로 낸다: `--chat-focus`, `--chat-working`, `--motion-accent`(= trace), `--agent-trace-color`, `--terminal-foreground`(캔버스 글자색), `--on-accent`(= `readableTextColor(accent)`). 앱 테마를 채팅 테마로 고른 경우에는 그 테마의 `accent`·`terminal.foreground` 로 지금 공식을 그대로 계산한다.
4. CSS: 채팅 관련 CSS 의 포커스 자리는 `var(--chat-focus, var(--accent))`, 진행 표시는 `var(--chat-working, var(--accent))` 로 바꾼다. 고정 그림자는 `var(--shadow-md)` 로 바꾼다. 앱 테마 따르기(`app`)일 때는 변수가 없으므로 지금과 같다.
5. 색 값 (직접 정함, 대비는 캔버스 / 바탕 기준):

| 테마 | focus | trace | working |
|---|---|---|---|
| 카톡 모드 | `#2f68b0` 파랑 4.5:1 | `#a86f00` 진한 노랑 3.4:1 | `#2f68b0` 5.3:1 |
| 미드나잇 | `#c0b3ff` 라벤더 9.5:1 | `#8fd3ff` 하늘 11:1 | `#c0b3ff` 9.1:1 |
| 종이 노트 | `#365c47` 초록 잉크 6.4:1 | `#b0662a` 적갈색 3.7:1 | `#365c47` 7.4:1 |

   빛(trace)은 포커스 테두리 바로 안쪽을 돌기 때문에 포커스와 다른 색 계열로 골랐다. 카톡 모드의 노란색은 하늘색 캔버스에서 1.2:1 이라 진하게 낮췄다.

## 바꾸는 파일

- `themes/chatThemes.ts` (motion 필드, 변수)
- `components/Terminal/LocalTerminalTab.tsx` (칸에 style)
- `components/Terminal/LocalTerminalTab.css`, `components/AgentChat/AgentChat.css`, `AgentSleepCover.css`, `AgentScreenReturnBar.css`, `AgentChatThemes.css`

## 테스트

- `themes/chatThemes.test.ts` (새 파일): 프리셋마다 `focus`·`trace` 의 캔버스 대비 3:1 이상, `working` 의 `bgPrimary` 대비 4.5:1 이상, `--on-accent` 와 `accent` 대비 4.5:1 이상. 앱 테마를 고르면 `--motion-accent` 가 그 테마 강조색.
- 화면: `local-agent-chat` 명세에 테마 셋을 바꿔 가며 작업 중·포커스·잠든 덮개 캡처를 더한다.

## 진행

- [x] 설계 승인 (디자인 세션 위임은 사용자가 뺌)
- [x] 연결(칸 style, 변수, CSS). 빛 변수는 `--chat-trace` 로 냈다: 포커스된 칸의 `::after` 가 `--agent-trace-color` 를 직접 지정해서, 물려받는 값으로는 덮이지 않는다
- [x] 색 값
- [x] 대비 테스트 15개, 단위 테스트 전체(3,261개), `local-agent-chat` 화면 테스트 통과. 카톡 모드에서 포커스된 칸의 테두리가 `rgb(47, 104, 176)` 인 것을 확인
