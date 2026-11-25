# Antigravity Chat View (Antigravity 채팅 보기)

[공통 작업 규칙과 기능별 목록](../../CLAUDE.md)

Windows 로컬 PowerShell 칸에서 실행 중인 Google Antigravity CLI(`agy`)를 같은 PTY에서 채팅으로 전환한다. 채팅은 대화와 작업 상태를 표시하고, 입력 대기 중에는 일반 텍스트를 보낸다. 진입과 재연결은 `LocalTerminalTab.tsx`와 `pendingChatViews.ts`, 상태와 입력은 `AgentChat/AgentChatCover.tsx`와 `src/agentChat/ipc.js`에서 처리한다.

- `src/localShell.js`는 대화형 `agy`에 세션 한정 `--settings`를 붙이고 사용자가 지정한 `--settings`는 그대로 전달한다. `src/ipc/antigravityStatusReport.js`와 `src/ipc/agentMessages.js`의 보고는 셸 토큰, 도우미 실행 파일과 `process.execPath`의 일치, `agy`에서 PTY로 이어지는 계보를 확인한 뒤 UUID·작업 폴더·상태를 해당 셸에 결합한다. 도우미와 `agy` 사이의 중간 프로세스로 Windows는 하나 이상의 `cmd.exe`만 허용하고, Unix는 `sh`만 허용한다. `app=antigravity` OSC가 보고한 차단 상태는 뒤늦은 `statusLine`의 `idle`보다 우선한다.
- 관리 실행과 Windows PowerShell에서 직접 입력한 `agy`는 도움말에 `--settings`가 있는지 확인하고, 구버전은 셸마다 안내를 한 번 표시한 뒤 사용자 인자 그대로 실행한다. PowerShell은 실행 파일 경로·크기·수정 시각이 바뀌면 다시 확인한다. [구버전 실행](../../docs/fix/2026-11-25-agy-old-version-settings-flag.md)
- 기록 경로는 PTY에 결합된 세션의 검증된 UUID로 조립한다. `statusLine`의 `transcript_path`는 경로 입력에서 제외한다. `src/agentChat/antigravitySessions.js`는 `%USERPROFILE%\.gemini\antigravity-cli\brain\<UUID>\.system_generated\logs` 안의 로컬 일반 파일만 열고, UNC·링크·정션과 루트 밖의 경로를 거부한다. `transcript_full.jsonl`을 우선하고 열 수 없으면 `transcript.jsonl`을 쓴다. 실시간 보기·이전 페이지·복사는 `chats.js`와 `antigravityTranscript.js`의 같은 읽기 경로를 쓴다.
- `src/ipc/antigravityInboxScreen.js`는 화면의 구분선·푸터·현재 캐럿과 선택 화면을 확인한다. `src/ipc/agentInboxWake.js`는 검증된 같은 세션의 `idle`과 빈 입력칸을 확인한 뒤 일반 텍스트를 붙여넣고, 다시 그려진 초안을 재확인해 Enter를 한 번 보낸다. 질문·도구 권한·작업 공간 신뢰·로그인 확인은 사용자가 같은 터미널로 전환해 처리한다. 채팅 창의 승인 및 선택지 응답 IPC는 Antigravity에 대해 차단한다.
- 1단계에서 차단하는 기능은 첨부·슬래시 명령과 메뉴·질문 카드·하위 에이전트 채팅·모델/속도 변경·재전송·작업 중 전송과 대기열·캡처 바로작업이다. 에이전트 메시지 MCP와 미확인 메시지 알림, 사용량 줄, 기록에서 다시 열기, 잠재우기도 후속 범위다.
- Windows 화면 테스트 `local-agent-chat-antigravity`는 관리 실행과 PowerShell에서 직접 실행한 `agy`, 세션별 기록, 질문 중 전송 차단과 터미널 전환, 셸 복귀를 확인한다. [1단계 설계](../../docs/plan/2026-11-23-antigravity-chat-view.md) [화면 테스트](../../e2e/specs/local-agent-chat-antigravity.js)
