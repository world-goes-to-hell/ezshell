# 작업 중에 보낸 채팅 메시지: 대기 중 표시와 흡수된 메시지 기록

## 증상 (2026-11-22 사용자 요청)

에이전트가 작업하는 동안 채팅에서 보낸 말은 CLI 가 붙잡아 두었다가 읽을 수 있을 때 읽는다.
화면에는 그 사실이 보이지 않아, 보낸 말이 이미 처리되는 것처럼 보였다 (진행 줄도 `답변 생성 중…`).

조사하다 함께 찾은 문제: Claude 가 작업 도중에 읽은 메시지는 기록 파일에 `type: user` 가 아니라
`type: attachment` + `attachment.type: queued_command` 줄로 남는다. 파서(`src/agentChat/claudeTranscript.js`)가
이 줄을 읽지 않아서, 그렇게 읽힌 메시지는 기록에 사용자 말로 잡히지 않았다. 화면의 즉시 표시(echo)만
30분 동안 남았고, 채팅을 다시 열면 그 말풍선이 사라졌다.

## Claude 기록의 모양 (이 PC 의 기록으로 확인)

1. 보낸 순간: `{"type":"queue-operation","operation":"enqueue","content":"…"}` (대기열일 뿐, 읽은 것이 아니다)
2. 작업 도중 읽음: `queue-operation` `remove`(`reason: absorbed_mid_turn`) 다음에
   `{"type":"attachment","attachment":{"type":"queued_command","prompt":"…","commandMode":"prompt","origin":{"kind":"human"}}}`
3. 작업이 끝난 뒤 읽음: `queue-operation` `dequeue` 다음에 평범한 `type: user` 줄

같은 `queued_command` 로 작업 알림(`origin.kind: task-notification`)과 다른 에이전트의 메시지(`peer`)도 온다.

## 수정

- 파서: `queuedPrompt` 가 `commandMode: prompt` 이고 `origin.kind: human` 인 줄만 사용자 말로 읽는다
  (`origin` 이 없는 옛 줄은 `<` 로 시작하지 않을 때만). 시각은 읽은 순간(줄의 timestamp)이다.
- 화면: 에이전트가 `작업 중` 일 때 보낸 말은 echo 에 `queued` 를 붙인다 (`agentChatStore.echoSend`).
  기록에 올라오기 전까지(`waitingItemIds`) 말풍선을 흐리게 하고 아래에 `대기 중…` 을 붙이며, 진행 줄은
  `앞 작업 진행 중…` 이다. 에이전트가 쉬는 상태가 되면 기록과 맞지 않았더라도 표시를 뗀다 (영원히 남지 않게).

## 왜 이렇게

- 큐에 들어간 것(`enqueue`)이 아니라 읽은 것(attachment 또는 user 줄)을 기준으로 해야 "읽을 때 사라진다" 가 맞다.
- Codex 는 다르다 (같은 날 확인, 이 PC 의 rollout 120개): 작업 중 입력을 **받는 즉시** 진행 중인 턴에
  `item_completed` `UserMessage` 로 쓴다. 명령이 39초 동안 도는 사이에 보낸 `ㅣ`, `;` 가 그 자리에서 0.4초 간격으로
  기록된 예가 있다 (모델은 명령이 끝나야 읽는다). 그래서 기록에 올라온 것만으로 표시를 떼면 0.5초 안에 사라진다.
  Codex 는 기록된 뒤에도 그 뒤에 모델 항목(생각·답변·도구·출력)이 나올 때까지 `대기 중…` 을 둔다
  (`agentChatStore` 의 `held`: 기록된 말의 id, `lib/agentChatItems.ts` 의 `nextHeld`·`isReadByModel`·`waitingItemIds`).
  터미널 보기로 갔다 와도 `keptEchoes` 가 `held` 를 함께 남긴다.
- `followUpQueueMode = "queue"` 설정이 있어도 위와 같이 동작했다 (CLAUDE.md 의 옛 설명을 고침).

## 시험

`claudeTranscript.test.js`(흡수된 메시지, 작업 알림·peer 제외, 편지함 알림 표시), `agentChatItems.test.ts`
(`waitingItemIds`, `nextHeld`), 화면 테스트 `local-agent-chat`(Claude: 작업 중 보내기 → 대기 중 → 흡수 줄이 오면 사라짐. Codex: 대기 중 → `UserMessage` 가 와도 유지 → 답변이 오면 사라짐. 둘 다 말풍선 하나).

## 추가: Esc 로 멈췄을 때 대기 중 질문 회수 (같은 날 사용자 보고)

증상: 작업 중에 보낸 질문이 대기하는 동안 Esc 를 누르면, Claude 는 턴을 멈추고 아직 안 읽은 질문을 자기 입력칸에 되돌린다.
터미널 보기에서는 그 질문이 입력칸에 돌아와 보이지만, 채팅 보기에서는 말풍선만 남고 채팅 입력칸은 비었다. 게다가 CLI 입력칸에 글이
남아 있어 다음 보내기가 `composer-not-empty`("에이전트 입력칸에 쓰던 글이 있습니다")로 거부되었다.

수정:
- main `agentInboxWake.takeBack(texts)`: CLI 입력칸이 보낸 글(여러 개면 합친 것, 공백 무시)과 정확히 같고 커서가 글 끝일 때만
  지우기 키(``)를 보내 비우고, 비워진 것을 확인한 뒤 성공을 돌려준다. 다르면 `different`, 비었으면 `empty` 로 손대지 않는다.
  IPC `agent-chat-take-back`(본창·잠금 해제, 글 10개·길이·제어 문자 검사), `localShell.chatTakeBack`.
- 화면 `stop()`: 중지 전에 대기 중(`queued`, 아직 기록 안 됨, 이미지 없음) 말을 기억해 두고, 중지가 받아들여지면
  `lib/chatTakeBack.ts` 의 `takeBackQueued` 가 0.2초 간격으로 12번까지 회수를 요청한다 (CLI 가 입력칸에 되돌리는 데 시간이 걸린다).
  성공하면 말풍선을 지우고(`discardSend`) 그 글을 채팅 입력칸의 쓰던 글 앞에 넣는다.

왜 이렇게: 창이 이미 보낸 글을 알고 있으므로 main 이 화면에서 글을 읽어 창에 넘기지 않는다 (화면 글을 그대로 넘기면 터미널에서 사용자가
쓰던 다른 글까지 옮겨질 수 있다). 지우기는 정확히 같은 글일 때만 한다.

남은 것: 터미널 보기에서 Esc 를 누른 경우에는 회수하지 않는다 (질문이 CLI 입력칸에 보이므로 사용자가 그대로 보낼 수 있다). 다만 채팅
보기로 돌아오면 그 말풍선이 남아 있다 (에이전트가 쉬면 `대기 중` 표시는 떨어진다).

시험: `agentInboxWake.test.js`(정확히 같을 때만 지움, 여러 줄, 다른 글·빈 입력칸은 그대로, 안 비워지면 실패), `chatTakeBack.test.ts`,
화면 테스트 `local-agent-chat`(작업 중 보내기 → Esc → 채팅 입력칸에 돌아오고 말풍선 사라짐 → 다시 보내기 성공).
