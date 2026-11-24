# 끝난 서브에이전트가 채팅 보기에서 계속 `작업 중`으로 남음

작성: 2026-11-24 (사용자 보고: `security-reviewer 작업 중 41분 44초`)

## 증상

Claude Code 채팅 보기의 서브에이전트 띠가, 백그라운드로 띄운 서브에이전트가 끝난 뒤에도 `작업 중`과 늘어나는 경과 시간을 보였다. 그 서브에이전트는 약 40분 전에 끝났고 결과도 부모 대화에 들어와 있었다.

## 원인

Claude Code 는 백그라운드 작업이 끝나면 부모 대화 기록에 `<task-notification>` 알림을 남긴다. 이 알림이 기록되는 모양이 두 가지다.

- 부모가 쉬는 중이면 `type: user` 줄 (본문이 `<task-notification>…` 글자)
- 부모가 일하는 중이면 대기열을 거쳐 `type: attachment` 줄: `attachment.type: queued_command`, `origin.kind: task-notification`, `commandMode: task-notification`, 알림 글자는 `attachment.prompt`

서브에이전트 추적기(`src/agentChat/subagents.js` 의 `claude`)는 `type: user` 줄만 읽어서, 부모가 일하는 중에 끝난 서브에이전트의 완료를 놓쳤다. 백그라운드 셸 추적기(`claudeShells.js`)는 이미 두 모양을 다 읽고 있었다.

이 세션의 실제 기록으로 확인했다: 고치기 전 추적기는 `security-reviewer | running`, 고친 뒤는 `completed` (끝난 시각 11:01:05).

## 수정

`noticeText(line)` 이 두 모양에서 알림 글자를 꺼낸다. 첨부 줄은 `origin.kind` 나 `commandMode` 가 `task-notification` 일 때만 받는다: 그동안 사용자가 친 글(`origin.kind: human`)이 알림처럼 보여도 완료로 치지 않는다. 알림 뒤의 처리(도구 id·작업 id 로 찾기, 결과·끝난 시각)는 그대로다.

## 시험

`subagents.test.js` 의 "reads a completion notice queued while the parent was working": 사용자가 친 비슷한 글로는 바뀌지 않고, 대기열 알림으로 `completed`·결과·끝난 시각이 들어간다.

## 반영

main 프로세스 코드라 앱을 다시 띄워야 적용된다. 다시 띄우면 대화 기록을 처음부터 읽으므로 이미 끝난 서브에이전트도 `완료`로 보인다.
