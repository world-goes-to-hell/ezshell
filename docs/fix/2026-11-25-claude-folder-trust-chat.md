# Claude 폴더 신뢰 확인을 채팅에 표시

Claude Code 2.1.331을 새 임시 폴더에서 열면 `No, exit`와 `Yes, I trust this folder`가 번호 없이 표시된다. 마지막 줄의 `Enter to confirm · Esc to cancel`은 일반 확인 질문과 같다. 기존 파서는 번호가 있는 질문과 채팅 입력칸을 찾았기 때문에, 이 화면에서는 에이전트를 `쉼`으로 표시하고 채팅 입력칸을 열었다.

Orca의 native chat은 보이는 화면 끝의 키 안내와 신뢰 선택지를 함께 확인한다. ezShell은 번호 유무와 선택 순서에 관계없이 두 선택지가 모두 보이고 하나가 선택되어 있으며 확인 안내로 끝나는 프레임을 폴더 신뢰로 판정한다. [Orca의 시작 화면 판정](https://github.com/stablyai/orca/blob/main/src/main/runtime/terminal/output/startup-dialog-screen.ts)

폴더 신뢰 화면이 보이면 상태를 `응답 필요`로 바꾸고 일반 채팅 입력과 받은 메시지 깨우기를 멈춘다. 채팅 패널의 안내 아래에 같은 터미널이 열리고 `터미널에서 답하기` 버튼은 그 터미널에 포커스를 준다. 신뢰 여부를 선택하는 키는 사용자가 터미널에 직접 입력한다. 신뢰 화면이 사라지고 입력칸이 돌아오면 채팅 입력을 다시 사용할 수 있다.

`agentInboxWake.test.js`는 번호 없는 화면과 번호 및 줄바꿈이 있는 화면에서 키 입력이 전달되지 않는지 확인한다. `local-agent-chat`은 터미널 표시, 채팅 전송 거부, 사용자가 입력한 Enter, 채팅 입력 포커스 복귀를 확인한다.
