# 에이전트 답변 띄워 두기

## 목적

채팅 보기에서 받은 답변(예: "화면 경로는 콘텐츠 > … 입니다", 확인할 주소와 순서)을 작은 창으로 띄워 두고, 그 창을 보면서 브라우저 탭이나 다른 탭을 오간다. 사용자 요청 (2026-11-20): 어느 페이지에서 무엇을 봐야 하는지 매번 채팅으로 돌아가 다시 읽지 않게.

## 결정

- 채팅 보기의 에이전트 답변에 포인터를 올리면 오른쪽 위에 `띄워 두기` 버튼. 누르면 그 답변이 별도 창으로 뜬다.
- 별도 창(테두리 없음, 본창의 자식 창, 작업 표시줄에 없음)이다. 앱 화면 안 카드로 만들면 브라우저 탭의 페이지(`WebContentsView`)에 가려진다: 이 기능을 가장 많이 쓸 곳이 브라우저 탭이다. 자식 창이라 ezShell 본창 위에 있고 다른 프로그램 위에는 있지 않다.
- 위치·크기는 분리 창처럼 종류(`pinnedReply`)마다 마지막 것을 기억한다 (`detachedPlaces.js`, 같은 자리의 창이 있으면 비켜 연다).
- 내용은 띄울 때의 답변을 복사해 둔다 (이후 대화가 바뀌어도 그대로). 같은 답변을 다시 띄우면 열린 창을 앞으로.
- 머리줄: 에이전트 아이콘, 대화 제목, 띄운 시각, `원래 대화로 가기`(본창의 그 칸을 채팅 보기로 앞에), `접기`(머리줄만), `닫기`.
- 한 번에 5개까지.

## 보안

- 내용은 main 의 메모리에만 둔다. 디스크에 쓰지 않는다. 잠그면 모든 창을 닫는다 (채팅 보기와 같다).
- 띄우기(`agent-chat-pin`)는 본창에서, 잠금 해제 상태에서만. 창의 요청(`pinned-reply-*`)은 그 창 자신의 것만 답한다 (보낸 webContents 로 찾는다).
- 링크: 띄울 때 그 대화가 이미 연 링크(`chats.knowsLink`) 가운데 이 답변에 든 것만 기억하고, 창은 그 링크만 연다. 상대 경로는 띄울 때의 에이전트 작업 폴더 기준. 채팅 보기와 같은 열기 경로(파일 창·탐색기·브라우저·브라우저 탭).
- 글은 채팅 보기와 같은 `renderChatMarkdown`(HTML 끔, 이미지 없음, 링크 검사)으로 그린다.

## 구현

- main: `src/agentChat/pins.js`(상태·검사), `src/agentChat/ipc.js`(IPC, 링크 열기 공용), `src/ipc/detachedWindows.js`(`createPinnedReplyWindow`), `src/detachedPlaces.js`(`KINDS`), `main.js`(연결, 잠금 때 `closeAll`).
- 화면: `App.tsx` 의 `pinnedReplyMode` 분기 → `AgentChat/PinnedReplyWindow.tsx`, `AgentChatCover.tsx` 의 버튼, 본창의 `pinned-reply-go` 처리.
- 디자인 시안: `mockups/pinned-reply-window.html` (GPT 세션).

## 진행

- [x] main
- [x] 화면
- [x] 단위 테스트(`pins.test.js` 7개, `ipc.test.js` 3개), 화면 테스트 `local-agent-chat` (띄우기·링크·다시 띄우기·접기·원래 대화로 가기·닫기)
- [x] CLAUDE.md (Agent Chat View 절)
