# 실제 CLI의 메시지 알림 화면

Windows ConPTY에서 Codex CLI 0.172.0과 Claude Code 2.1.332로 기록했다. CLI는 임시 프로필로 실행했고 모델 응답은 로컬 HTTP 서버에서 제공했다. `submittedNotice`는 Ctrl+A 또는 Home으로 입력 시작점에 이동한 뒤 Enter를 눌러 서버가 받은 문장이다. Codex 작업 중 Enter는 문장을 현재 작업에 전달했고, Claude 작업 중 Enter는 문장을 대기열에 추가했다. Claude의 문장은 앞선 작업을 끝낸 뒤 서버에 도달했다.

| 표본 | 확인할 화면 |
| --- | --- |
| `codex-100x24-idle.json` | 경고 표시가 없는 넓은 편집기 |
| `codex-100x24-warning.json` | 넓은 편집기의 경고 줄과 F2 상세 |
| `codex-59x24-warning-wrapped.json` | `⚠ 1 · f2`가 붙여넣기 뒤 `⚠ 1 warning · f2 to view`로 바뀌고 알림이 두 줄로 접힘 |
| `codex-59x15-warning-wrapped.json` | 낮은 칸에서 접힌 알림, 경고 줄과 F2 상세 |
| `codex-59x24-post-turn-warning.json` | 작업을 한 번 끝낸 뒤 뜬 모델 메타데이터 경고와 접힌 `REMIND_PROMPT` |
| `codex-59x15-queue.json` | `Queued follow-up inputs`와 `tab to queue message`가 있는 화면 |
| `codex-100x15-update.json` | 업데이트 선택창과 Esc로 닫은 뒤 돌아온 편집기 |
| `claude-100x24-idle.json` | 넓은 편집기와 바닥줄에 놓인 PTY 커서 |
| `claude-100x24-settings-warning.json` | 잘못된 임시 설정의 `Settings Warning`과 `Continue` 뒤 돌아온 편집기 |
| `claude-100x15-idle.json` | 낮은 편집기와 위쪽에 놓인 PTY 커서 |
| `claude-59x24-wrapped.json` | 구분선 사이 두 줄로 접힌 알림 |
| `claude-59x15-queue.json` | `Press up to edit queued messages` 제안, 접힌 알림, Enter 뒤 대기열 |
| `claude-59x15-existing-queue-app.json` | Claude에 기존 요청이 있을 때 앱이 붙인 알림. 일반 커서와 Ctrl+A를 각각 기록했고 로컬 서버에서 기존 요청, 작업 중 알림, 후속 알림 순서를 확인함 |

`cols`, `rows`는 캡처 시 칸 크기다. `phases.idle`, `pasted`, `atStart`, `enter`는 붙여넣기 전, 붙여넣은 직후, 커서를 입력 시작점으로 옮긴 뒤, Enter 뒤 화면이다. 일부 표본에는 `warningDetail`, `queued`, `queueDrained`, `updatePrompt`, `settingsWarning`이 있다. F2 상세와 업데이트 선택창에서는 Enter를 누르지 않았다. Claude의 `settingsWarning`은 `Continue`를 선택해 닫은 뒤 편집기 제출을 검증했다.

각 화면의 `lines`, `wraps`, `cursor`는 가상 터미널에서 읽은 값이다. 좌표는 0부터 센다. `frame`은 같은 크기의 가상 터미널에 `writeOutput`으로 공급할 수 있는 화면 재생 문자열이다. 흐린 글자와 반전 표시를 보존한다. 재생할 때 열 끝의 자동 줄바꿈 대기 좌표는 마지막 열로 맞춘다. 줄바꿈 플래그가 필요한 검사는 `wraps`를 사용한다.

시작 경고 표본은 임시 실행에서 인식되지 않는 설정 하나를 줘서 만들었다. 별도 실행에서 `--no-daemon`과 현재 ezShell 훅 인자를 주었을 때는 F2에 임베디드 모드 관련 안내가 표시됐고 훅 시간 제한 경고는 표시되지 않았다. 작업 뒤의 모델 메타데이터 경고는 로컬 모델 서버 응답에서 발생했다. 업데이트 선택창은 임시 프로필의 버전 캐시에 더 높은 버전을 써서 띄웠다. 실행 파일을 업데이트하지 않았다. [Codex 버전 캐시 구현](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/tui/src/updates_cache.rs)

2.36.0의 `agentInboxWake`에 59×15 경고 표본을 재생하면 `pasted` 단계는 Enter까지 간다. 같은 문장이 보이면서 커서가 첫 줄인 `atStart`에서는 Enter를 보내지 않고 5초 뒤 초안의 `ours`가 `false`였다. 이 재생에서는 관찰기에 Home 키를 전달하지 않았다. 실제 세션에서 커서가 처음 어긋난 원인은 확인되지 않았다.

`npx vitest run src/ipc/agentInboxWake.test.js -t 'actual Codex and Claude PTY frames'`로 재생한다. 이 폴더의 JSON을 자동으로 불러와 깨우기와 채팅의 Enter, 중복 제출, 사용자 키 입력, 경고 상세·업데이트·설정 선택 화면을 검사한다.
