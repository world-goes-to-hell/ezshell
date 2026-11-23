# 채팅 보기에서 Claude 의 질문(AskUserQuestion)을 채팅 카드로 답하기

2026-11-23 사용자 요청: Claude 가 선택지 질문을 하면 채팅 보기도 터미널 화면을 그대로 보여 준다. 채팅 디자인으로 답하고 싶다.

## 지금 상태
- `agentInboxWake.claudeQuestionPrompt` 가 터미널 화면에서 질문을 알아보고(`usesTerminalInput: true`), 채팅은 `답변 대기 중` 과 `질문에 답하기`(터미널 넘기기)만 보여 준다.

## 근거: 기록과 키 동작 (Claude Code 2.1.3xx, 2026-11-23 실제 CLI 로 확인)
- 질문은 띄우는 순간 기록에 `tool_use` `AskUserQuestion` 으로 남는다: `questions[{ question, header, multiSelect, options[{ label, description }] }]`. 답은 `toolUseResult.answers` (`{ 질문: "답1, 답2" }`).
- 화면: 질문이 둘 이상이거나 여러 개 고르는 질문이면 위에 탭 줄(`←  ☐ Color  ☐ Fruits  ✔ Submit  →`). 선택지 뒤에 `Type something` 과 `Chat about this` 가 번호를 이어 받는다.
- 단일 선택: 숫자 키 = 고르고 다음 질문으로(마지막이면 확인 화면, 질문이 하나뿐이면 바로 제출). 직접 입력: `Type something` 번호 → 글자 → Enter.
- 여러 개 고르기: 숫자 키 = 체크 토글(선택 표시 `❯` 는 그대로). 직접 입력은 `↓` 로 `Type something` 줄에 가서 글자를 치면 체크와 글이 함께 들어간다. 맨 아래 `Next`/`Submit` 줄에서 Enter = 다음.
- 확인 화면: `Review your answers`, `● 질문` / `→ 답`, `❯ 1. Submit answers` / `2. Cancel`. 답하지 않은 질문이 있으면 `⚠ Some questions are unanswered`.

## 설계
1. main 파서(`claudeTranscript.js`)가 `AskUserQuestion` 을 `tool.question`(정리·길이 제한)으로, 결과의 답을 `tool.answers` 로 붙인다. `parser.question(toolId)` 로 답하지 않은 질문을 main 이 다시 꺼낸다.
2. 창은 질문 카드(`AgentChat/AskQuestionCard.tsx`)를 그린다: 질문마다 단계, 선택지 버튼(설명 포함)·체크 상자, 직접 입력, 마지막에 고른 답 확인과 `보내기`. 카드는 화면에 질문이 떠 있을 때(`approval.usesTerminalInput`)만 답할 수 있고, 기록의 질문과 화면의 질문이 맞지 않으면 예전처럼 `질문에 답하기`.
3. 창은 tool id 와 답(선택지 번호, 직접 입력 글)만 보낸다 (`agent-chat-answer-questions`). main 이 자기 기록의 질문으로 키를 정하고 `src/ipc/claudeQuestions.js` 가 키마다 화면을 확인하며 누른다. 제출 전에 확인 화면의 답이 고른 답과 같은지 본다. 어긋나면 멈추고 창은 터미널로 넘긴다.
4. 누르는 동안 `setHeld` 로 메시지 알림·채팅 보내기를 막는다. 직접 입력 글은 제어 문자 거부, 한 줄, 500자.
5. 답한 질문은 기록의 답으로 `질문 → 답` 카드로 보여 준다 (JSON 입력 대신).

## 진행
- [x] 파서·단위 테스트 (`askQuestions.test.js`)
- [x] 키 드라이버·단위 테스트 (가짜 화면 `e2e/support/fakeAskDialog.js`)
- [x] IPC·preload·타입
- [x] 카드 UI·답한 질문 표시
- [x] 화면 테스트 `local-agent-chat` (카드로 답하기, 터미널에서 답하기)
- [x] 실제 Claude 로 확인: 100x45, 48x30(안내 줄 접힘), 80x18(질문이 위로 밀림). 질문 3개(단일·체크·체크로 끝남), 4개(체크·직접 입력·단일·단일, 16줄 칸 포함)도 제출 확인. 함정은 `docs/brain/2026-11-23-claude-ask-dialog-screen-quirks.md`
- [x] CLAUDE.md
