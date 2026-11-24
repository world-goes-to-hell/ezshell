# 채팅 보기: Claude 의 선택 창 때문에 글이 안 들어가는데 이유가 안 보임

작성: 2026-11-24 (사용자 보고: Claude Code 가 "Teach auto mode about your environment?" 창을 띄운 동안 채팅 보내기가 계속 실패했고, 채팅에는 아무 표시 없이 안 된다는 말만 떴다)

## 원인
채팅 보기는 에이전트 화면의 확인 질문을 `agentInboxWake.js` 의 `readApprovalScreen` 으로 읽어 질문 카드로 보여 주고, 그동안 보내기를 막는다 (`chatBlocked`, 이유 `approval`). 이 함수는 두 가지를 전제로 했다.
- 입력칸이 보이면 질문이 없다: 입력칸이 보이는 동안 대화에 찍힌 번호 목록을 질문으로 오인하지 않으려는 규칙이다.
- 선택지가 화면 맨 아래에서 4줄 안에 있다.

그런데 이 창은 입력칸이 그대로 그려진 위에 떠 있고, 그 아래에 "Heads up · … 1: Learn more 2: Knew this already 0: Dismiss" 안내가 붙어 선택지가 맨 아래에서 멀었다. 그래서 질문 카드가 뜨지 않았다. 보내기도 막히지 않아 글을 붙여 넣었지만 키를 창이 받아 제출되지 않았고, 결과는 입력칸 판정의 일반 실패 문구(입력칸에 쓰던 글이 있음, 또는 글이 그대로 들어가지 않음)였다.

## 수정
- `readApprovalScreen`: Claude 화면에서 `Enter to confirm · Esc to cancel` 안내 바로 위(빈 줄 하나 허용)에 번호 선택지가 있으면, 입력칸이 보이든 아래에 무엇이 있든 그 선택지를 질문으로 읽는다 (`CLAUDE_DIALOG_HINT`, `dialogEnd`). 이 경로에서는 선택 표시(`❯`)가 있어야 한다: 대화 속 번호 목록에는 선택 표시와 이 안내가 없다. 질문 문장과 설명은 기존처럼 창의 위 가로줄까지 읽는다.
- 그래서 채팅에 질문 카드가 뜨고(번호로 답하면 기존 `answerApproval` 경로), 보내기는 `approval` 로 막힌다. `approval` 문구를 "에이전트 화면에 선택 질문이 떠 있어 보내지 않았습니다. 질문 카드에서 고르거나 터미널에서 답한 뒤 다시 보내 주세요." 로 바꿨다 (`src/agentChat/ipc.js` 의 `REASONS`).
- Orca 의 PTY 보내기에는 질문 창 확인이 없다. 이 판정은 ezShell 이 이미 하던 "질문 중에는 보내지 않음"을 이 창에도 적용한 것이다 (새 거절 조건이 아니다).

## 시험
`agentInboxWake.test.js`: 보고 화면을 그대로 그린 화면에서 질문·선택지·선택 표시를 읽는지, 그 화면에서 보내기가 `approval` 로 거절되고 아무것도 쓰지 않는지, 입력칸 위 대화의 번호 목록은 질문이 아닌지. 고치기 전에는 앞의 둘이 실패했다(질문 없음, 보내기 5초 멈춤). 파일 전체 164개 통과, `vitest related` 219개 통과.

화면 테스트 `local-agent-chat` 은 `Codex lists its question outside the virtual viewport` 한 항목이 두 번 모두 실패했다. 이 수정은 Claude 화면 읽기에만 닿고, 같은 시각에 다른 세션이 `src/agentChat/chats.js` 를 고치고 있어 그쪽에 확인을 넘겼다.
