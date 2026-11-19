# 에이전트 사용량을 앱에 표시

날짜: 2026-11-19
상태: 구현 완료 (커밋 전). 단위 테스트(`agentUsage`·`agentUsageMessages`·`codexUsageWatcher`·`agentUsageView`), 화면 테스트 `local-agent-usage` 10개, `local-agent-messages` 통과. 실제 경로 확인: Git Bash → Electron(node 모드) → 에이전트 파이프로 0.07초 안에 저장된다. 남은 것: `codex resume` 으로 옛 기록 파일에 이어 쓰는 Codex 세션은 아직 찾지 못한다.

## 목표

ezShell 이 띄운 Claude Code·Codex 의 사용량(5시간·7일 한도, 컨텍스트, 모델)을 터미널 줄을 쓰지 않고 앱의 상태 줄에 보여 준다. claude-hud 같은 상태 줄이 터미널에서 2~3줄을 차지하던 것을 없앤다.

## 확인한 사실 (2026-11-19)

- Claude Code 2.1.328 은 상태 줄 명령의 표준 입력으로 JSON 을 준다: `rate_limits.five_hour`·`seven_day`(`used_percentage`, `resets_at` 초), `context_window`(사용 비율·크기), 모델. 한도는 첫 API 응답 뒤부터, 구독자에게만 들어 있다. claude-hud 는 한도를 로그인 토큰으로 Anthropic API 를 불러 얻지만, 우리는 Claude 가 넘겨주는 값만 쓴다.
- 상태 줄 명령의 출력에 따라 Claude 화면의 줄 수가 다르다 (가상 터미널로 확인): 출력 없음·실패 → 빈 줄 1개, 색 초기화 코드(`\x1b[0m`)만 → 줄 없음.
- Claude 의 `--settings <파일>` 은 설정을 더 읽어 와 그 실행에서만 상태 줄을 바꾼다. 사용자의 전역 설정(claude-hud)은 그대로 남는다.
- Codex 0.170.0 은 기록 파일(`sessions/YYYY/MM/DD/rollout-*.jsonl`)의 `event_msg`/`token_count` 줄에 `rate_limits.primary`·`secondary`(`used_percent`, `window_minutes`, `resets_at`)와 `info.last_token_usage`·`model_context_window` 를 남긴다.

## 설계

- Claude: ezShell 이 띄우는 Claude 에 `--settings` 로 상태 줄을 붙인다. 상태 줄 명령(`src/ipc/agentUsageReport.js`, ezShell 실행 파일을 node 로 실행)은 입력에서 숫자 몇 개만 골라 에이전트 메시지 파이프로 앱에 보내고(`usage` 요청, 그 에이전트의 토큰으로만), 화면에는 `\x1b[0m` 만 찍는다. 실패해도 같은 것만 찍는다.
- Codex: main 이 실행 중인 Codex 에이전트마다, 같은 폴더에서 그 에이전트가 시작된 뒤 생긴 기록 파일을 찾아(다른 에이전트가 잡은 파일 제외) 크기가 바뀔 때만 끝부분을 읽는다 (3초 간격, stat 하나).
- main 은 에이전트별 최신 사용량을 들고 있다가 바뀔 때만 본창에 `agent-usage` 로 보낸다. 창은 시작할 때 `agent-usage-state` 로 한 번 받는다.
- 화면: 에이전트가 도는 로컬 터미널(칸) 바로 아래 얇은 줄에 `모델 · 5H ▓▓░░ 23% 2h10m · 7D 41% · CTX 38%`. 70% 넘으면 노랑, 90% 넘으면 빨강. (처음에는 앱 상태 줄에 두었다가 사용자 요청으로 칸 아래로 옮겼다.)

## 바꾸면 안 되는 것

- 로그인 토큰·인증 파일을 읽지 않는다. 앱으로 오는 값은 숫자와 모델 이름뿐이다 (경로·대화 내용 없음).
- `usage` 요청은 등록된 에이전트의 토큰으로만 받는다 (그 에이전트의 사용량으로만 저장).
- 사용자의 전역 Claude 설정 파일을 고치지 않는다.

## 시험

- 단위: 상태 줄 입력 → 사용량 변환(필드 없음·이상한 값), Codex `token_count` 변환과 창 길이로 5H/7D 구분, 기록 파일 고르기(폴더·시작 시각·이미 잡힌 파일), 상태 줄 표시 문자열(남은 시간, 색 기준).
- 실행 인자: Claude 실행 줄에 `--settings` 가 붙는지 (기존 `localShellResume`·`localShell` 테스트 갱신).
- 화면 테스트: 가짜 에이전트가 사용량을 보내면 상태 줄에 보이는지.
