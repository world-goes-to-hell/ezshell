# 등록 세션용 MCP 서버 설계

- 작성일: 2026-10-01
- 상태: 설계 승인됨 (구현 계획 작성 전)

## 1. 목적

Claude Code 에서 이 앱에 등록된 SSH 세션으로 서버를 조회할 수 있게 한다.
비밀번호와 키는 Claude 에게 넘기지 않고, 앱이 대신 접속해서 명령 결과만 돌려준다.

### 합의 사항 (사용자 결정)
| 항목 | 결정 |
|---|---|
| 명령 범위 | 자유 입력 명령(파이프 포함)을 받는다. 위험도에 따라 바로 실행하거나, 확인 창을 띄우거나, 절대 차단한다 |
| 적용 대상 | 모든 세션에 같은 규칙. 세션별 "MCP 접근 허용" 스위치로만 구분한다 (개발/운영 구분 없음) |
| 클라이언트 | Claude Code 만 지원한다. 전송 방식은 로컬 HTTP (Streamable HTTP) |
| 구조 | 앱 main 프로세스에 MCP 서버를 내장한다 (A안) |
| 위험 명령 | 확인 창에서 허용하면 실행한다. 단, 절대 차단 목록은 허용할 수 없다 |
| 알림 수준 | 확인 창을 띄우는 기준. `모든 명령` / `중간 이상` / `위험만`(기본값) |
| 처음 보는 명령 | 위험으로 분류한다 |

### 성공 기준
- Claude Code 에서 `list_sessions`, `cd`, `run_command` 를 호출해 허용된 세션의 서버를 조회할 수 있다.
- 위험 명령은 어떤 설정에서도 사람의 확인 없이 실행되지 않는다.
- 절대 차단 명령은 어떤 경우에도 실행되지 않는다.
- 모든 요청(실행, 허용, 거부, 차단, 시간 초과)이 감사 로그에 남는다.
- 비밀번호, 키, 호스트 주소, 사용자명이 MCP 응답에 포함되지 않는다.

### 범위 밖
- Claude Code 외 클라이언트(stdio 중계 프로그램). 나중에 붙일 수 있게 main 쪽 인터페이스만 분리해 둔다.
- 출력에서 비밀번호, 개인정보 자동 가림.
- 사용자가 직접 정책 목록을 편집하는 기능.

## 2. 구조

```
Claude Code ──HTTP(127.0.0.1, 토큰)──▶ [앱 main 프로세스]
                                         ├─ MCP 서버 (도구 3개)
                                         ├─ 명령 정책: 위험도 판정
                                         ├─ 승인 중계 ──IPC──▶ [렌더러] 확인 창
                                         ├─ 세션 게이트웨이: 복호화된 세션으로 SSH 접속
                                         └─ 감사 로그: userData/mcp-audit.log
```

세션 비밀번호는 마스터 비밀번호로 암호화되어 있고, 복호화 키(`currentMasterPassword`)는 앱이 잠금 해제된 동안에만 main 메모리에 있다.
따라서 MCP 서버는 독립 프로그램이 아니라 실행 중인 앱 안에 있어야 한다.

### 도구
| 도구 | 입력 | 동작 | 응답 |
|---|---|---|---|
| `list_sessions` | 없음 | MCP 접근이 허용된 세션 목록 | 세션 ID, 이름, 폴더 경로, 현재 작업 디렉터리. 호스트, 사용자명, 인증 정보는 제외 |
| `cd` | `session`, `path` | `cd '<현재>' && cd -- '<경로>' && pwd` 로 이동 가능 여부 확인 후 위치 저장 | 새 작업 디렉터리 |
| `run_command` | `session`, `command` | 정책 판정 → (필요 시) 확인 창 → 실행 | 세션, 작업 디렉터리, 종료 코드, 잘림/시간 초과 여부, stdout, stderr |

`cd` 는 낮음 위험도로 판정한다. 같은 정책과 알림 수준을 따른다.
- 작업 디렉터리는 `cd` 도구로만 바뀐다. `run_command("cd /x && ls")` 처럼 명령 안에서 `cd` 해도 그 명령 안에서만 적용되고 저장되지 않는다.
- 아직 접속하지 않은 세션의 작업 디렉터리는 `list_sessions` 에서 `null` 로 표시하고, 첫 접속 때 홈 디렉터리로 정한다.

### main 프로세스 모듈 (`src/mcp/`)
| 파일 | 역할 | 의존성 |
|---|---|---|
| `commandPolicy.js` | 명령 문자열 → `{ level: 'low' \| 'medium' \| 'danger' \| 'forbidden', reasons: string[] }` | 없음 (순수 함수) |
| `shellQuote.js` | 경로를 작은따옴표로 안전하게 인용 | 없음 |
| `sessionGateway.js` | 세션별 SSH 연결 재사용, 실행, 타임아웃, 출력 제한, 작업 디렉터리 관리 | `ssh2`, `sshConnectionTest.js` 의 연결 옵션 조립 |
| `approval.js` | 렌더러에 확인 요청을 보내고 응답 대기 | Electron IPC (주입) |
| `auditLog.js` | 줄 단위 JSON 기록, 5MB 초과 시 파일 교체 | `fs` |
| `server.js` | HTTP 서버, 토큰·Host·Origin 검사, MCP 도구 등록, 위 모듈 조합 | `@modelcontextprotocol/sdk` |

- 각 모듈은 Electron 객체를 직접 참조하지 않고 주입받는다. 그래야 Vitest 에서 단독으로 테스트할 수 있다.
- `main.js` 는 `require('./src/...')` 모듈을 번들하지 않고 `electron.vite.config.ts` 의 `MAIN_RUNTIME_MODULES` 로 `out/main/src` 에 복사한다. `src/mcp/` 디렉터리 전체를 복사 대상에 추가해야 한다.

### 렌더러
- **설정 > MCP 탭**
  - 서버 켜기/끄기 (기본 꺼짐)
  - 포트 (기본 47521, 사용 중이면 오류 표시)
  - 알림 수준 (기본 `위험만`)
  - 토큰 보기/복사/재발급
  - 등록 명령 복사: `claude mcp add --transport http my-ssh-client http://127.0.0.1:<포트>/mcp --header "Authorization: Bearer <토큰>"`
  - 감사 로그 최근 200건 (시각, 세션, 명령, 위험도, 결과, 종료 코드)
- **세션 모달**: "MCP 접근 허용" 스위치. 세션 데이터에 `mcpEnabled?: boolean` (기본 꺼짐)
- **확인 창**: 세션 이름과 폴더 경로, 작업 디렉터리, 명령 전체(고정폭), 위험도, 판단 근거, 남은 시간. 기본 포커스는 `거부`

### 설정 저장
- `settings.json` 에 `mcp: { enabled, port, token, alertLevel }` 를 둔다.
- 토큰은 `crypto.randomBytes(32)` 로 만든 hex 문자열이다. 평문으로 저장한다. Claude Code 설정(`~/.claude.json`)에도 평문으로 들어가므로 여기서만 암호화해도 이득이 작다. 노출이 의심되면 재발급한다.

## 3. 명령 정책

### 판정 순서
1. **셸 문법 분해**: 따옴표(`'`, `"`)와 이스케이프(`\`)를 해석해 단어로 나누고, `;` `&&` `||` `|` `&` 줄바꿈 기준으로 명령 조각으로 나눈다.
2. **명령 이름 추출**: 경로를 떼고(`/usr/bin/rm` → `rm`), 앞의 환경 변수 대입(`FOO=1 cmd`)을 건너뛴다.
   감싸는 명령(`sudo`, `env`, `nohup`, `timeout`, `xargs`, `nice`, `command`, `exec`, `time`)은 감싼 명령 자신의 위험도와 안쪽 명령의 위험도 중 높은 값으로 판정한다. (`sudo` 자체는 위험)
3. **조각별 판정 후 최댓값**이 전체 위험도다.
4. **문법 기반 판정**
   - `$(…)`, 백틱, `<(…)`, `>(…)`: 안쪽 명령을 같은 규칙으로 판정한다.
   - 출력 리다이렉션 `>`, `>>`, `>|`, `&>`: 위험. 단, 대상이 `/dev/null` 이거나 `2>&1` 같은 파일 디스크립터 복제는 허용.
   - 끝의 `&`(백그라운드): 위험.
   - 히어닥(`<<`): 중간.
   - 해석 실패(닫히지 않은 따옴표 등): 위험.

### 위험도 기준
| 위험도 | 기준 |
|---|---|
| 절대 차단 | `rm` 에 재귀/강제 옵션이 있고 대상이 `/`, `/*`, `~`, `~/`, `$HOME` 이거나 `--no-preserve-root` 가 있음. `mkfs*`, `dd` 의 `of=/dev/…`, `/dev/sd*`·`/dev/nvme*` 로의 리다이렉션, `shutdown` `reboot` `halt` `poweroff`, `init 0/6`, `systemctl reboot/poweroff/halt`, 포크 폭탄 패턴, 대상이 `/` 인 `chmod -R`/`chown -R` |
| 위험 | 파일 변경: `rm` `rmdir` `mv` `cp` `ln` `touch` `mkdir` `chmod` `chown` `chgrp` `truncate` `tee` `install` `sed -i`<br>프로세스·서비스: `kill` `pkill` `killall` `systemctl`(조회 외) `service` `docker`(조회 외) `kubectl`(조회 외) `pm2` `supervisorctl`<br>권한: `sudo` `su` `doas`<br>설치: `apt` `apt-get` `yum` `dnf` `pip` `npm` `yarn`<br>임의 코드: `bash` `sh` `zsh` `python*` `perl` `ruby` `node` `php`, `./…` 또는 경로로 실행하는 파일<br>원격: `ssh` `scp` `sftp` `rsync` `nc` `ncat` `telnet`<br>DB: `mysql` `psql` `redis-cli` `mongo` `mongosh` `sqlite3`<br>편집기: `vi` `vim` `nano` `emacs`<br>`find` 의 `-exec` `-execdir` `-ok` `-delete` `-fprint*`, `tar` 의 생성/추출, `git`(조회 외), `crontab`(`-l` 외), `curl` 의 `-o` `-O` `-T` `-d` `-X POST/PUT/DELETE`, `wget`, `mount` `umount` `iptables` `useradd` `passwd`<br>**처음 보는 명령** |
| 중간 | 비밀 정보 경로를 인자로 사용: `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `id_ed25519*`, `.ssh/`, `/etc/shadow`, `/etc/sudoers`, `.pgpass`, `.my.cnf`, `application*.yml`, `application*.properties`, `*credentials*`, `*secret*`<br>`env`, `printenv`<br>루트 기준 전체 탐색: `find /`, `grep -r … /`, `du /`<br>끝나지 않는 명령: `tail -f/-F/--follow`, `journalctl -f`, `docker logs -f`, `watch`, `top`(배치 모드 제외)<br>`curl`(그 외), `awk`, `sed`(`-i` 제외), 히어닥 |
| 낮음 | `ls` `cd` `pwd` `cat` `head` `tail` `less` `more` `grep` `egrep` `zgrep` `rg` `wc` `sort` `uniq` `cut` `tr` `jq` `diff` `stat` `file` `tree` `du` `df` `free` `uptime` `uname` `hostname` `whoami` `id` `date` `ps` `top -b` `lsof` `vmstat` `iostat` `netstat` `ss` `ip addr/route/link` `which` `type` `echo` `basename` `dirname` `realpath` `readlink` `md5sum` `sha256sum` `zcat` `nproc` `lscpu` `w` `who` `last`, `systemctl status/is-active/is-enabled/list-units/show/cat`, `journalctl`, `docker ps/logs/images/inspect/stats --no-stream/top`, `docker compose ps/logs`, `kubectl get/describe/logs/top`, `git log/status/diff/show/branch`, `tar -t`, `crontab -l`, `find`(위험 옵션 없음) |

정책은 실수를 막는 장치이지 의도적인 우회를 완벽히 막는 보안 경계가 아니다. 애매하면 높은 쪽으로 분류하고, 최종 안전장치는 확인 창과 감사 로그다.

### 알림 수준과 처리
| 알림 수준 | 낮음 | 중간 | 위험 | 절대 차단 |
|---|---|---|---|---|
| 모든 명령 | 확인 | 확인 | 확인 | 차단 |
| 중간 이상 | 실행 | 확인 | 확인 | 차단 |
| 위험만 (기본) | 실행 | 실행 | 확인 | 차단 |

## 4. 요청 처리 흐름

1. **접속 검사**: `Authorization: Bearer <토큰>` 을 시간 일정 비교(`crypto.timingSafeEqual`)로 확인. `Host` 가 `127.0.0.1:<포트>` 또는 `localhost:<포트>` 가 아니면 거부. `Origin` 헤더가 있으면 거부 (브라우저발 요청, DNS 리바인딩 차단). 서버는 `127.0.0.1` 에만 바인딩한다.
2. **상태 검사**: 앱 잠김 → "앱이 잠겨 있습니다. 앱에서 잠금을 해제하세요". 세션 없음 또는 `mcpEnabled` 꺼짐 → "허용되지 않은 세션입니다".
3. **정책 판정**: 절대 차단이면 거절. 알림 수준에 따라 확인이 필요하면 4번.
4. **확인 창**: 렌더러에 IPC 로 요청. 앱이 최소화/비활성이면 Windows 알림을 띄우고 작업 표시줄 아이콘을 깜빡인다. 요청은 하나씩 순서대로 묻고, 60초 무응답이면 거부.
5. **실행**: 세션 연결을 재사용(Jump Host 지원)해 `cd '<작업 디렉터리>' && <명령>` 을 PTY 없이 `exec`. 30초 초과 시 채널을 닫는다. stdout, stderr 는 각각 64KB 에서 자르고 ANSI 제어 문자를 제거한다. UTF-8 로 해석한다.
6. **기록과 응답**: 감사 로그 기록 후 응답.

### 연결 관리
- 세션별 SSH 연결을 재사용하고, 5분 동안 쓰지 않으면 닫는다.
- 같은 세션의 요청은 하나씩 순서대로 처리한다 (`cd` 순서 보장).
- 작업 디렉터리 초기값은 접속 계정의 홈(`pwd` 결과)이다.

## 5. 오류 처리

| 상황 | 처리 |
|---|---|
| SSH 접속 실패 | `describeSshError` 로 원인만 알림. 호스트, 계정 정보는 응답에 넣지 않음 |
| 명령 도중 연결 끊김 | 풀에서 제거하고 오류 응답. 다음 요청에서 재접속 |
| 타임아웃 | 채널을 닫고 부분 출력과 `시간 초과` 표시 |
| 세션 수정·삭제 | 해당 세션 연결을 닫는다 |
| 앱 잠금, MCP 끔 | 대기 중인 확인 요청을 모두 거부하고 연결을 닫는다 |
| 렌더러가 확인 창을 띄울 수 없음 | 거부 |
| 포트 사용 중 | 서버를 켜지 않고 설정 화면에 오류 표시 |
| 감사 로그 기록 실패 | 실행하지 않고 거부 |
| 도구 처리 중 예외 | 잡아서 `isError` 응답. main 프로세스가 죽지 않게 한다 |

## 6. 테스트

1. `commandPolicy.test.js`: 위험도별 대표 명령, 우회 시도(`ls;rm x`, `ls && rm x`, `echo $(rm x)`, 백틱, `ls | xargs rm`, `/bin/rm`, `\rm`, `r''m`, `FOO=1 rm`, `env rm`, `sudo ls`, `find . -delete`, `cat a > b`, 줄바꿈 연결, 끝의 `&`, 닫히지 않은 따옴표), 허용해야 하는 경우(`2>&1`, `> /dev/null`, `grep "a;b" f`)
2. `shellQuote.test.js`: 공백, 작은따옴표, 한글이 섞인 경로
3. `sessionGateway.test.js`: 테스트 안에서 `ssh2` 서버를 띄워 실행, 타임아웃, 출력 제한, 작업 디렉터리 유지, 연결 재사용, 순차 처리
4. `approval.test.js`, `auditLog.test.js`: 가짜 타이머로 60초 거부, 순차 처리 / 형식, 5MB 교체, 기록 실패 시 거부
5. `server.test.js`: 임의 포트로 서버를 띄우고 SDK 클라이언트로 도구 목록 조회와 호출. 잘못된 토큰, `Origin` 포함, 잠긴 상태 거부
6. 실제 연동: Claude Code 에 등록해 로컬 테스트 SSH 서버로 명령 실행, 확인 창 동작 확인
7. `src/mcp/` 커버리지 80% 이상

## 7. 위험 요소와 대응

| 위험 | 대응 |
|---|---|
| MCP SDK 의존 패키지(`jose` 등)가 ESM 전용이라 Electron 28(Node 18.18) CommonJS main 에서 `require` 실패 | 구현 첫 단계에서 실제 로드를 확인한다. 실패하면 electron-vite main 빌드에서 SDK 를 번들에 포함(외부화 제외)한다 |
| 정책 우회 | 애매하면 높은 위험도, 처음 보는 명령은 위험, 확인 창 기본 포커스는 거부, 감사 로그 |
| 출력에 섞인 비밀 정보, 개인정보가 Claude 로 전송됨 | 중간 위험도 판정과 확인 창으로 대응. 자동 가림은 하지 않는다 (범위 밖) |
| 읽은 로그를 통한 프롬프트 인젝션 | Claude Code 의 호출별 승인과 앱 확인 창, 감사 로그 |
| dev 모드에서 main/preload 변경은 앱 재시작 후 반영 | 새 preload API 는 `typeof` 확인 후 호출 (기존 LockScreen 패턴) |
