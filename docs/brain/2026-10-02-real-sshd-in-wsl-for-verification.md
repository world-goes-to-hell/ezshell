# 실제 sshd 가 필요한 검증은 WSL 에서 일반 사용자 권한으로 sshd 를 띄운다

## 문제
MCP 백그라운드 작업의 "중지하면 서버의 프로세스가 실제로 죽는다" 는, `ssh2` 의 `Server` 로 만든 가짜 서버로는 확인할 수 없었다.
프로세스 그룹, 시그널 요청, 채널을 닫았을 때 프로세스가 남는지 같은 동작은 실제 sshd 와 실제 셸이 있어야 나온다.
세션 목록의 서버는 모두 사내 서버라서 쓸 수 없다. Docker 는 꺼져 있었다.

## 해결
WSL(Ubuntu-24.04)에 sshd 가 설치되어 있지 않아도, 패키지를 **설치하지 않고** 내려받아 풀어서 일반 사용자로 실행할 수 있다.

1. `apt-get download openssh-server libwrap0` (root 불필요, 현재 폴더에 .deb 만 받는다) → `dpkg -x <deb> <폴더>` 로 푼다.
2. 호스트 키와 클라이언트 키를 `ssh-keygen` 으로 만든다. 클라이언트 키는 `-m PEM` 으로 만들면 `ssh2` 가 읽는다.
3. 설정 파일: `Port 2255`, `HostKey`, `AuthorizedKeysFile` 을 임시 폴더 경로로, `UsePAM no`, `StrictModes no`, `PasswordAuthentication no`.
   root 가 아닌 sshd 는 **자신을 실행한 계정으로만, 공개키 인증으로만** 로그인을 받는다 (비밀번호 인증은 안 된다).
4. `LD_LIBRARY_PATH=<푼 폴더>/usr/lib/x86_64-linux-gnu <푼 폴더>/usr/sbin/sshd -D -e -f <설정>` 을 **절대 경로**로 실행한다.
   `-D` 로 앞에서 돌려야 한다. 데몬으로 보내면 `wsl.exe` 가 끝날 때 WSL 인스턴스와 함께 내려갈 수 있다. Bash 도구의 백그라운드 실행으로 띄워 둔다.
5. Windows 쪽에서는 `127.0.0.1:2255` 로 접속된다 (WSL2 의 localhost 전달).
6. 앱 세션은 `authType: 'privateKey'`, `privateKeyPath` 에 복사해 둔 클라이언트 키 경로를 준다.

서버에서 실제로 무엇이 도는지는 앱과 별개의 연결로 `ps -eo args | grep -c "^sleep 600$"` 처럼 세어 확인한다.
"구버전 서버(시그널 요청 무시)" 는 클라이언트 쪽에서 `stream.signal = () => {}` 로 흉내 낼 수 있다.

## 함정
- **Git Bash 에서 `wsl -d Ubuntu-24.04 -- bash -lc '...'` 로 여러 명령을 넘기면 안 된다.** 따옴표 안의 `$HOME`, `$D` 같은 변수가 빈 값이 되어
  `mkdir -p $D` 가 `missing operand` 로 실패했고, 나머지 명령(`apt-get download`, `dpkg -x ... root`)은 **Windows 의 현재 폴더(= 프로젝트 폴더)** 에서 실행됐다.
  프로젝트 루트에 `.deb` 파일과 `root/` 폴더가 생겼다. 스크립트에 `rm -rf root` 도 있었는데, 같은 이름의 폴더가 프로젝트에 있었다면 지워졌을 것이다.
  → 스크립트를 파일로 쓰고(Write) `wsl -d Ubuntu-24.04 -- bash /mnt/c/.../script.sh <인자>` 로 실행한다. 스크립트 첫머리에서 자기 작업 폴더로 `cd` 한다.
  Git Bash 가 `/mnt/c/...` 인자를 Windows 경로로 바꾸지 않도록 `MSYS_NO_PATHCONV=1` 을 붙인다.
- `sshd` 만 받아서 실행하면 `libwrap.so.0` 을 찾지 못한다. `libwrap0` 도 함께 받아 `LD_LIBRARY_PATH` 로 알려 준다.
- `wsl.exe` 는 Windows 의 현재 폴더를 그대로 물려받는다. 임시 파일을 만드는 명령은 항상 절대 경로를 쓴다.

## 이 방법으로 확인한 사실 (OpenSSH 9.6, 2026-10-02)
- PTY 없이 실행한 셸은 pid = pgid = sid 다. 그래서 `kill -KILL -- -<셸 PID>` 로 작업의 프로세스 전체가 죽는다.
- 채널을 닫고 연결까지 끊어도 `sleep` 은 서버에 남는다. 30초 제한의 `run_command` 도 같은 방식으로 중단하므로, 구버전 서버에서는 중단 뒤에 프로세스가 남을 수 있다.

## 사례
2026-10-02 MCP 백그라운드 작업 도구. 스크립트는 세션 scratchpad 의 `sshd-run.sh`, `real-sshd-check.cjs`, `verify-jobs.mjs` 에 있었다 (임시).
WSL 쪽 임시 파일은 `~/.cache/ezshell-sshd-test` 에 있다 (다음에 다시 쓸 수 있고, 지워도 된다).
