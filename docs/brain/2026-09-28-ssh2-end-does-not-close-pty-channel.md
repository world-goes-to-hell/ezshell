# ssh2: 쉘 채널을 `end()` 로 닫으면 서버에 채널이 남는다

## 증상
같은 SSH 연결에서 쉘/exec 채널을 열고 닫기를 반복하면 어느 순간부터
`Channel open failure: open failed` 가 난다. 첫 몇 번은 정상이라 타이밍 문제로 오진하기 쉽다.

## 원인
ssh2 클라이언트 채널은 `allowHalfOpen: true` 가 기본이다. `stream.end()` 는 EOF 만 보낸다.
PTY 가 붙은 쉘은 EOF 로 종료되지 않으므로 서버 세션이 살아 있고, 연결당 세션 한도(`MaxSessions` 10)를 소진한다.

## 판별
- "처음엔 되고, 닫았다 다시 열면 안 된다" + 재시도/대기로 해결되지 않음 → 채널 누수.
- 지연 시간을 늘리거나 재시도를 추가해서 증상이 줄어드는 것처럼 보여도 근본 해결이 아니다.

## 해결
채널을 끝낼 때 `stream.close()` (또는 `destroy()` = end + close) 를 호출한다.

## 사례
2026-09-28 my-ssh-client 분할 터미널. 상세: docs/fix/2026-09-28-split-reopen-channel-open-failure.md
