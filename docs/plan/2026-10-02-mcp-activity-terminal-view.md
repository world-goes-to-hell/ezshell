# MCP 활동 패널의 터미널 보기

- 날짜: 2026-10-02
- 구분: 중간 (화면·편의 기능. Claude 에게 새로 넘어가는 정보 없음)
- 상태: 구현·검증 완료, 설치본 반영 대기

## 목적
Claude Code 가 MCP 로 실행하는 명령과 출력을, 사용자가 터미널처럼 이어진 화면에서 실시간으로 지켜본다.
지금은 목록에서 요청을 하나씩 펼쳐야 하고, 출력은 명령이 끝난 뒤에야 보인다.

## 결정
- 새 탭 종류를 만들지 않고 "MCP 활동" 패널 안에 `목록 | 터미널` 전환을 둔다. 탭은 모두 SSH 연결 하나를 전제로 한다(분할, SFTP, 재연결, 배지, 창 분리).
- 읽기 전용. 실행은 지금처럼 게이트웨이의 별도 연결에서 한다(종료 코드와 출력의 정확성 유지). "중지" 버튼은 유지.
- 제어 문자를 뺀 텍스트만 표시한다. xterm 을 쓰지 않는다.
- 패널을 자동으로 열지 않는다.
- 출력은 메모리에만 두고 잠금 때 지운다. 명령당 stdout·stderr 각 64KB 제한 유지.

## 데이터 흐름
```
sessionGateway.exec (조각 도착) → onOutput(stream, text)
  → tools.guarded → activity.appendOutput(id, stream, text)
  → activityLog: item.outputParts 에 누적 + 50ms 묶음 → emitOutput({ id, parts })
  → main.js 'mcp-activity-output' → preload onMcpActivityOutput
  → mcpActivityStore.appendOutput → McpActivityTerminal
```
- 요청이 끝나면 기존 `mcp-activity` 이벤트가 `outputParts` 전체를 담은 항목을 보낸다. 이 항목이 기준이므로, 중간 조각이 빠지거나 겹쳐도 끝나면 바로잡힌다.
- 항목에 `cwd` 를 추가한다. 시작 때 아는 값을 쓰고, 모르면(`null`) `run_command` 결과의 값으로 채운다.

## 파일
| 파일 | 변경 |
|---|---|
| `src/mcp/sessionGateway.js` | `run(..., { onOutput })`. 버퍼가 받아들인 조각만, 스트림별 디코더로 문자 경계를 지켜 전달 |
| `src/mcp/activityLog.js` | `appendOutput`, 묶음 전송(`emitOutput`), 끝난 요청·`clear()` 때 대기 조각 버림 |
| `src/mcp/tools.js` | `onOutput` 연결, 활동 항목에 `cwd` |
| `src/mcp/controller.js`, `main.js`, `src/preload.js` | `mcp-activity-output` 채널 |
| `src/renderer/types/index.ts` | `McpOutputPart`, `outputParts`, `cwd`, `onMcpActivityOutput` |
| `src/renderer/lib/mcpActivity.ts` | `appendOutputParts`, `cleanTerminalText` |
| `src/renderer/stores/mcpActivityStore.ts`, `hooks/useMcpActivityFeed.ts` | 조각 반영, 보기 상태 |
| `src/renderer/components/Mcp/McpActivityTerminal.tsx` | 새 컴포넌트 |
| `src/renderer/components/Mcp/McpActivityPanel.tsx`, `McpActivity.css` | 보기 전환, 스타일 |

## 테스트 (로직만)
- `activityLog`: 조각 누적(같은 스트림은 합침), 50ms 묶음 전송, 끝난 요청에는 붙이지 않음, 끝나면 대기 조각을 따로 보내지 않음, `clear()` 뒤 전송 없음, 전송 실패해도 동작
- `sessionGateway`: 조각마다 콜백, 64KB 를 넘은 부분은 전달하지 않음, 여러 바이트 문자가 조각 경계에서 깨지지 않음, 콜백이 던져도 실행 결과는 정상, `pwd`(홈 확인)는 전달하지 않음
- `tools`: 출력이 활동 항목에 쌓임, 감사 로그에는 출력이 들어가지 않음
- `lib/mcpActivity`: 조각 병합, 끝난 항목에는 붙이지 않음, 제어 문자 제거
- 화면: typecheck + 실제 앱 확인 1회

## 진행
- [x] 계획
- [x] 테스트 작성 (실패 16개 확인)
- [x] main 쪽 구현
- [x] 화면 구현
- [x] 기능 단위 검토 1회 (CRITICAL/HIGH 없음. 아래 "검토 반영")
- [x] 전체 테스트 1,111개 / typecheck / build
- [x] 실제 앱 확인 (별도 프로필의 dev 앱 + 테스트용 SSH 서버, CDP 로 화면 확인)
- [ ] 사용자가 쓰는 설치본에 반영 (새 버전 설치 또는 재시작 필요)

## 검토 반영
- 스냅숏과 대기 중인 조각이 겹쳐 출력이 두 번 보일 수 있었다 → `activityLog.list()` 가 대기 조각을 먼저 보낸다.
- 제어 시퀀스가 조각 경계에서 갈리면 `[31m` 같은 찌꺼기가 남았다 → 리포터가 끝나지 않은 시퀀스를 다음 조각까지 보류한다 (64자를 넘거나 명령이 끝나면 ESC 만 빼고 내보낸다).
- 출력과 작업 디렉터리의 방향 제어·폭 없는 문자를 화면에서 제거한다.
- 반영하지 않음: 잠금 때 렌더러 스토어에 남는 항목 (이 기능 이전부터 있던 동작이고, 잠금 해제 후 스냅숏으로 교체된다). 따로 다룰 만하다.

## 실제 앱에서 확인한 것
- 느린 명령(0.6초마다 한 줄)의 출력이 실행 중에 나타나고, "실행 중 · N초" 와 중지 버튼이 보인다.
- stderr 는 붉은색, 0 이 아닌 종료 코드는 경고색. 차단·만료·취소는 출력 대신 이유를 보여 준다.
- 확인 대기 중인 요청을 터미널 보기의 중지 버튼으로 취소할 수 있다.
- `<script>` 가 든 출력은 글자 그대로 보이고 요소가 만들어지지 않는다.
- 목록 보기와 전환해도 양쪽 다 동작한다. 새 출력이 오면 맨 아래를 따라간다.

## 알아 둘 것
- 상태바의 "MCP 활동" 버튼은 첫 요청이 들어온 뒤에야 나타난다 (기존 동작).
- 위험 명령은 확인 창에서 60초 동안 기다린다. 리다이렉션(`<`, `>`)이 들어간 명령도 위험으로 판정된다.
