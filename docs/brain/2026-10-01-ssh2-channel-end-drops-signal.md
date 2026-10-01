# ssh2: stdin 을 end() 한 채널에는 signal('KILL') 이 전달되지 않는다

## 증상
MCP 명령 실행에서 "입력을 기다리며 30초 멈추는 문제"를 막으려고 exec 채널이 열리자마자 `stream.end()` 를 호출했다.
그 뒤로 중지 버튼과 30초 시간 초과가 원격 명령을 죽이지 못했다. 채널만 닫히고, pty 가 없으니 sshd 는 프로세스를 살려 둔다
(승인한 `rm -rf ...` 를 중지해도 끝까지 실행됨).

## 원인
ssh2 1.17.0 `lib/Channel.js`:
- `signal()` 은 채널이 writable 이고 열린 상태일 때만 패킷을 보낸다 (Channel.js:237-245).
- `end()` 는 상태를 `'eof'` 로 바꾸고 `writable = false` 로 만든다 (Channel.js:268-272).
즉 `end()` 이후의 `signal('KILL')` 은 조용히 버려진다. 예외도 없다.

## 왜 바로 못 잡았나
테스트의 가짜 stream 이 `signal()` 을 상태와 무관하게 기록했다. KILL 테스트가 계속 통과해서 회귀가 가려졌다.
최종 재리뷰에서 실제 Channel 클래스로 확인하고서야 드러났다.

## 해결
- `stream.end()` 를 쓰지 않는다.
- stdin 은 원격 스크립트 안에서 닫는다: `<cd guard>\nexec </dev/null\n<command>` (POSIX).
- 가짜 stream 도 ssh2 처럼 `end()` 뒤에는 signal 을 버리게 했다 (sessionGateway.test.js).

## 교훈
라이브러리 객체를 흉내 내는 fake 는 "상태에 따라 무시되는 호출"까지 흉내 내야 한다. 아니면 그 상태를 만드는 변경이 테스트를 그대로 통과한다.
