# 분할을 껐다가 다시 켜면 `Channel open failure: open failed`

- 작성일: 2026-09-28

## 증상
처음 분할은 정상. 분할을 끈 뒤 다시 켜면 그 연결에서는 계속
`(SSH) Channel open failure: open failed` 로 분할 쉘 생성이 실패한다 (재시도 3회 모두 실패).

## 원인
`ssh-split-close` 가 `stream.end()` 로 분할 쉘을 닫았다.
ssh2 1.17 클라이언트 채널은 `allowHalfOpen` 기본값이 true 라서 `end()` 는 EOF 만 보내고
CHANNEL_CLOSE 는 보내지 않는다 (`node_modules/ssh2/lib/Channel.js` 의 `onFinish`).
PTY 쉘은 EOF 를 받아도 종료되지 않으므로 서버 쪽 세션 채널이 그대로 남는다.
분할을 끌 때마다 채널이 쌓여 서버의 연결당 세션 한도(OpenSSH `MaxSessions`, 기본 10)에 걸리면 새 채널이 거부된다.

## 수정
`ssh-split-close` 에서 `stream.close()` 호출 (CHANNEL_CLOSE 전송 → 서버가 세션 종료).
연결 전체를 닫는 `ssh-disconnect` 는 `conn.end()` 로 모든 채널이 함께 닫히므로 그대로 둔다.

## 참고
이 문제 때문에 과거에 `ssh-create-shell` 의 "실패 시 stale 스트림 정리 후 재시도",
"생성 전 선제 정리"(같은 세션의 살아 있는 분할까지 끊던 코드), 렌더러의 지수 백오프 재시도가 덧붙여졌다.
모두 채널이 실제로 닫히지 않는 근본 원인을 우회하려던 시도였다.

## 2차: `close()` 수정 후에도 간헐적으로 실패
### 원인
`SplitTerminal` 의 쉘 생성 흐름에서, `sshCreateShell` 응답을 기다리는 사이 컴포넌트가 언마운트되면
응답 후 `if (disposed) return` 으로 끝나 **이미 열린 쉘을 아무도 닫지 않았다.**
- 개발 모드: `React.StrictMode` 가 effect 를 mount → unmount → mount 로 두 번 실행하므로
  분할 터미널 하나를 열 때마다 쉘이 2개 생기고 1개가 버려졌다 (로그의 "Creating split shell" 이 항상 두 번씩 찍힘).
- 설치형 빌드: 분할을 빠르게 끄고 켤 때 같은 경로로 누수.
버려진 채널이 쌓이는 속도가 조작에 따라 달라 "간혹" 실패하는 것처럼 보였다.

### 수정
응답을 받았을 때 이미 `disposed` 면 `sshSplitClose(result.streamId)` 로 즉시 닫는다.
성공 후에는 대기 단계 전에 `streamIdRef` 를 먼저 채우므로, 그 이후의 언마운트는 기존 정리 함수가 닫는다.

### 교훈
비동기로 외부 자원을 여는 effect 는 "열기 완료 시점에 이미 정리됐는지"를 확인하고, 정리됐다면 연 자원을 반드시 닫아야 한다.

## 3차: 누수 해결 확인 + 개발 모드의 순간 한도 초과
### 측정 (main 진단 로그 `[split] ... openChannels=N`)
- 분할을 반복해서 켜고 꺼도 채널 수가 매번 기준값 3 으로 돌아옴 → 누수는 해결됨 (opened 148 / closed 147, 나머지 1개는 열려 있는 분할).
- 실패 3건은 모두 `openChannels=10` 시점: 기준 3 + 동시에 열린 분할 쉘 7개.
  StrictMode 가 분할마다 쉘을 두 번 열고 하나를 곧바로 닫기 때문에, 4분할 전환 순간 채널이 한도(10)에 닿았다. 재시도로 복구됨.
### 수정
`SplitTerminal` 이 채널을 열기 전 항상 한 매크로태스크를 기다리게 함 (`setTimeout(resolve, delay)`, delay 기본 0).
StrictMode 의 첫 실행은 그 사이 정리되어 쉘을 열지 않는다. 설치형 빌드에서도 빠른 토글 시 불필요한 채널 생성을 줄인다.
### 진단 로그
main 의 `[split] opened/closed/close requested/open failed` 로그와 실패 메시지의 `(열린 채널 N개)` 는 재발 시 원인 파악용으로 유지한다.
