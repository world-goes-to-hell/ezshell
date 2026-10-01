# 분할 터미널을 열 때 첫 출력(로그인 배너, 첫 프롬프트)이 사라지던 문제

## 증상
- 분할 터미널을 열면 화면이 비어 있고, Enter 를 쳐야 프롬프트가 나왔다.
- 접속하자마자 출력하는 서버에서는 로그인 메시지 일부가 보이지 않았다.

## 원인
`main.js` `ssh-create-shell` 은 채널이 열리는 즉시 `stream.on('data')` 로 `ssh-split-data` 를 보낸다.
`SplitTerminal.tsx` 의 `handleSplitData` 는 아래 두 구간에 도착한 데이터를 버렸다.
1. `sshCreateShell` 응답 전 — `streamIdRef` 가 아직 null 이라 자기 채널인지 알 수 없음
2. 응답 후 xterm 을 만드는 동안 — DOM 대기, `new Terminal`, `open` 이 끝나기 전(`isInitialized` false)

메인 터미널은 `terminalStore.sshDataBuffers` 로 같은 상황을 버퍼링하고 있어 문제가 없었다.

## 수정
- `src/renderer/lib/earlyStreamBuffer.ts` (+테스트 5개): 채널별로 도착 순서대로 모아 두고 `take(streamId)` 로 자기 것만 꺼낸다. 꺼낼 때 다른 채널 것은 모두 버린다.
  채널당 256K 상한, 한 번 넘치면 그 채널은 더 받지 않는다 (중간이 빠진 출력이 이스케이프 시퀀스를 깨지 않게).
- `SplitTerminal.tsx`
  - `handleSplitData`: id 를 모르면 모든 채널을 버퍼에, id 를 알지만 터미널이 준비 전이면 자기 채널을 버퍼에
  - `isInitialized.current = true` 직후 같은 동기 흐름에서 버퍼를 꺼내 `term.write` → 이후 도착하는 데이터가 앞질러 쓰이지 않음

### 왜 렌더러에서 버퍼링했나
메인 프로세스에서 "렌더러 준비 완료" 신호를 받을 때까지 모아 두는 방법도 있지만, 새 IPC 가 필요하고
앱 빌드 후 재시작 전에는 새 preload API 가 없을 수 있다(LockScreen Safe API Pattern). 렌더러 안에서 끝나는 방식을 택했다.

## 검증
- 단위 테스트 5개, 타입 체크, 전체 테스트 통과
- 실제 앱 E2E (셸마다 번호를 붙인 배너 3줄 + 프롬프트를 내는 테스트 서버)
  - 즉시 출력: Enter 없이 배너 → 프롬프트 순서대로 한 번씩 표시
  - 첫 출력 1초 지연: 정상 (기존 경로)
  - quad 로 분할 3개 동시 생성 (첫 출력 지연 0 / 50 / 300ms): 패널마다 자기 셸의 출력만, 섞임/중복 없음
  - 회귀: 자동완성 42/42, 분할 11/11, 콘솔 에러 없음

## 별도로 발견 (이번 수정과 무관, 미처리)
- 가로 분할에서 quad 로 바꾸면 기존 분할 패널도 닫혔다가 새 셸로 다시 열린다 (앱 로그: 기존 split close → 새 split 3개 open).
  CLAUDE.md 의 "SplitTerminal Key Stability" 설명과 다르다. 의도된 동작인지 확인 필요.
