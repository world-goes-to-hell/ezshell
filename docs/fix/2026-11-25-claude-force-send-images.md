# Claude 채팅에서 여러 줄 본문과 이미지를 강제로 보내기

Windows 개발 앱과 Claude Code 2.1.332에서 이미지 두 장을 붙이고, 본문을 4줄 또는 40줄 입력했다. 두 경우 모두 Claude가 입력칸에 `[Image #1] [Image #2][Pasted text #3 +3 lines]`와 같은 형태를 그렸다. 이전 코드는 이미지 표시 뒤에 본문이 그대로 보이는 경우만 읽었다. 새 초안이 입력칸에 표시됐어도 `not-drawn`과 “입력칸에 글이 그대로 들어가지 않아 보내지 않았습니다”가 반환됐다.

## 수정

- Claude가 같은 입력칸에 서로 다른 이미지 표시를 첨부 수만큼 그리고, 이어서 본문이나 붙여넣기 표시를 그리면 제출한다. 강제 지우기 뒤 빈 화면이 생략되면 이전 이미지·본문 표시가 섞이거나 남은 초안에 새 내용이 이어진 화면을 거부한다. 이미지 읽기에는 최대 10초를 준다.
- 강제 지우기 후 나타난 초안이 비어 있지 않고 이전과 다르면 한 차례 더 지운다. 두 번째 지우기 뒤에는 빈 화면을 확인한 다음 붙여 넣는다. 승인 화면, 셸 프롬프트, 입력 대상 변경, 사용자 키 입력은 계속 전송을 막는다. Enter는 한 번만 보낸다.
- 이미지와 본문을 확인하지 못하면 해당 입력칸을 확인하라는 오류를 표시한다. 초안이 남아 있으면 입력칸이 비워지지 않았다고 표시한다.

Orca도 강제 지우기 뒤 140ms를 기다렸다가 초안이 남아 있으면 한 번 더 지운다. 붙여넣기 판정은 이미지 표시와 Claude 본문의 붙여넣기 표시를 따로 읽는다. [Orca 초안 지우기](https://github.com/stablyai/orca/blob/main/src/renderer/src/components/native-chat/session/terminal/send/native-chat-input-clear.ts) [Orca 붙여넣기 판정](https://github.com/stablyai/orca/blob/main/src/renderer/src/components/native-chat/session/terminal/send/native-chat-paste-landed.ts)

## 검증

- 실제 Claude 입력칸에 일반 초안, 43줄 붙여넣기 초안, 이미지가 든 43줄 초안을 각각 둔 뒤 강제로 보냈다. 세 번 모두 새 이미지 블록 두 개와 전체 본문이 Claude 대화 기록에 한 번만 저장됐다. 실제 CLI에서는 지우다가 초안 일부만 남는 화면을 관찰하지 않았다.
- 관련 단위 테스트 276개가 통과했다. 빈 화면 생략, 이미지 누락·중복, 이전 표시가 남는 경우, 지우기를 한 번 더 해야 하는 상황을 포함했다.
- `npm run typecheck`와 `npm run build` 통과.
- Windows `local-agent-chat` 화면 검사 298개가 통과했다. 빈 화면 없이 Claude 붙여넣기 표시가 나타난 상황에서 강제 전송 승인, 첨부 두 장과 40줄 원문이 한 번 제출되는지, 보낸 썸네일 순서를 확인했다.
