// Per-command rules for the MCP command policy. A rule receives the words after the
// command name and returns a finding: { level, reason? }. Unknown commands are dangerous.

const allow = require('./commandAllowlists.js')
const extra = require('./commandRulesExtra.js')

const { LOW, MEDIUM, DANGER, FORBIDDEN, low, medium, danger, forbidden, hasFlag, positional, startsWithAny } = allow

const LOW_COMMANDS = new Set([
  'ls', 'll', 'dir', 'cd', 'pwd', 'cat', 'head', 'less', 'more', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'wc',
  'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'diff', 'cmp', 'stat', 'file', 'tree', 'df', 'free', 'uptime', 'uname',
  'hostname', 'whoami', 'id', 'groups', 'date', 'cal', 'ps', 'pgrep', 'pidof', 'lsof', 'vmstat', 'iostat', 'mpstat',
  'netstat', 'ss', 'which', 'whereis', 'type', 'echo', 'printf', 'basename', 'dirname', 'realpath', 'readlink',
  'md5sum', 'sha1sum', 'sha256sum', 'zcat', 'zless', 'bzcat', 'xzcat', 'nproc', 'lscpu', 'lsblk', 'lsmem', 'w', 'who',
  'last', 'lastlog', 'true', 'false', 'test', '[', 'sleep', 'column', 'nl', 'fold', 'rev', 'tac', 'strings', 'od',
  'hexdump', 'xxd', 'getent', 'locale', 'arch', 'dmesg', 'timedatectl', 'hostnamectl'
])

const DANGER_GROUPS = {
  '파일 변경': ['rmdir', 'mv', 'cp', 'ln', 'touch', 'mkdir', 'truncate', 'tee', 'install', 'shred', 'unlink', 'rename'],
  '프로세스·서비스 변경': ['kill', 'pkill', 'killall', 'service', 'pm2', 'supervisorctl'],
  '패키지 설치·변경': ['apt', 'apt-get', 'yum', 'dnf', 'apk', 'pip', 'pip3', 'npm', 'npx', 'yarn', 'pnpm', 'gem'],
  '임의 코드 실행': ['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python2', 'python3', 'perl', 'ruby', 'node',
    'php', 'lua', 'eval', 'source', '.'],
  '원격 접속·전송': ['ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'telnet', 'ftp'],
  'DB 클라이언트(데이터 변경 가능)': ['mysql', 'mariadb', 'psql', 'redis-cli', 'mongo', 'mongosh', 'sqlite3'],
  '대화형 편집기': ['vi', 'vim', 'nvim', 'nano', 'emacs'],
  '파일 다운로드': ['wget'],
  '시스템 설정 변경': ['mount', 'umount', 'iptables', 'ip6tables', 'nft', 'ufw', 'firewall-cmd', 'sysctl', 'modprobe',
    'swapoff', 'swapon'],
  '계정 변경': ['useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'passwd', 'chpasswd'],
  '예약 작업 변경': ['at', 'batch']
}
const DANGER_REASONS = new Map(
  Object.entries(DANGER_GROUPS).flatMap(([reason, names]) => names.map(name => [name, reason]))
)

const FORBIDDEN_COMMANDS = new Map([
  ['shutdown', '시스템 종료'], ['reboot', '시스템 재부팅'], ['halt', '시스템 정지'], ['poweroff', '시스템 종료'],
  ['mke2fs', '파일시스템 포맷']
])

const ROOT_TARGETS = new Set(['/', '/*', '/.', '//', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*', '${HOME}'])

const FIND_DANGER_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'])
function findRule(args) {
  if (args.some(arg => FIND_DANGER_ACTIONS.has(arg))) return danger('find: 실행·삭제 옵션')
  const paths = []
  for (const arg of args) {
    if (arg.startsWith('-') || arg === '(' || arg === '!') break
    paths.push(arg)
  }
  return paths.includes('/') ? medium('find: 루트 전체 탐색') : low()
}

function grepRule(args, name) {
  const recursive = name === 'rg' || hasFlag(args, 'rR', ['--recursive', '--dereference-recursive'])
  if (name === 'rg' && args.some(arg => startsWithAny(arg, ['--pre', '--hostname-bin']))) return danger('rg: 외부 프로그램 실행 옵션')
  return recursive && positional(args).includes('/') ? medium(`${name}: 루트 전체 검색`) : low()
}

function rmRule(args) {
  const recursiveOrForce = hasFlag(args, 'rRf', ['--recursive', '--force'])
  if (args.some(arg => allow.longOptionMatches(arg, '--no-preserve-root')) || (recursiveOrForce && positional(args).some(arg => ROOT_TARGETS.has(arg)))) {
    return forbidden('rm: 루트·홈 전체 삭제')
  }
  return danger('rm: 파일 삭제')
}

function recursiveRootRule(args, name) {
  if (hasFlag(args, 'R', ['--recursive']) && positional(args).includes('/')) return forbidden(`${name} -R /: 전체 권한·소유자 변경`)
  return danger(`${name}: 권한·소유자 변경`)
}

function initRule(args, name) {
  return ['0', '6'].includes(args[0]) ? forbidden(`${name} ${args[0]}: 시스템 종료·재부팅`) : danger(`${name}: 실행 수준 변경`)
}

const RULES = {
  tail: (args) => (hasFlag(args, 'fF', ['--follow']) ? medium('tail -f: 끝나지 않는 명령') : low()),
  top: (args) => (hasFlag(args, 'b', ['--batch']) ? low() : medium('top: 대화형이라 끝나지 않음 (-b 필요)')),
  find: findRule,
  grep: grepRule,
  egrep: grepRule,
  fgrep: grepRule,
  zgrep: grepRule,
  rg: grepRule,
  du: (args) => (positional(args).includes('/') ? medium('du: 루트 전체 용량 계산') : low()),
  crontab: (args) => (hasFlag(args, 'l') && !hasFlag(args, 'eri') ? low() : danger('crontab: 예약 작업 변경')),
  printenv: () => medium('printenv: 환경 변수 출력(비밀 정보 포함 가능)'),
  rm: rmRule,
  chmod: recursiveRootRule,
  chown: recursiveRootRule,
  chgrp: recursiveRootRule,
  dd: (args) => (args.some(arg => arg.startsWith('of=/dev/')) ? forbidden('dd: 디스크 장치에 직접 쓰기') : danger('dd: 디스크·파일 쓰기')),
  init: initRule,
  telinit: initRule,
  ...extra.EXTRA_RULES
}

const SAFE_ENV_NAME = /^(LANG|LANGUAGE|LC_[A-Z0-9_]+|TZ|TERM|COLUMNS|LINES|NO_COLOR)$/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Finding for an environment assignment that could change how a command behaves, else null */
function assignmentFinding(word) {
  const name = word.slice(0, word.indexOf('='))
  return SAFE_ENV_NAME.test(name) ? null : danger(`${name}=…: 환경 변수로 명령 동작 변경`)
}

// Wrapper checks look at the wrapper's own options and assignments (the words it consumed).
const ENV_SPEC = { ...allow.SPECS.env, passThrough: (word) => ASSIGNMENT.test(word) }
function envCheck(prefix) {
  const findings = prefix.filter(word => ASSIGNMENT.test(word)).map(assignmentFinding).filter(Boolean)
  if (!allow.parseAllowlist(prefix, ENV_SPEC).ok) findings.push(danger('env: 허용 목록에 없는 옵션(-S 등은 문자열을 명령으로 실행)'))
  return findings
}
const timePrefix = (prefix) => (allow.parseAllowlist(prefix, allow.SPECS.time).ok ? [] : [danger('time: 허용 목록에 없는 옵션(-o 등은 파일에 씀)')])
const ionicePrefix = (prefix) => (prefix.some(arg => /^-[A-Za-z]*[pPu]/.test(arg) || ['--pid', '--pgid', '--uid'].some(name => allow.longOptionMatches(arg, name)))
  ? [danger('ionice: 다른 프로세스의 우선순위 변경')] : [])

/**
 * Commands that run another command. `finding` is the wrapper's own risk, `valueOptions`
 * take the next word as their value, `whenEmpty` applies when no inner command follows.
 */
const WRAPPERS = {
  sudo: { finding: danger('sudo: 권한 상승'), valueOptions: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '--user', '--group'] },
  doas: { finding: danger('doas: 권한 상승'), valueOptions: ['-u', '-C'] },
  su: { finding: danger('su: 다른 계정으로 전환'), valueOptions: ['-c', '-s', '--command', '--shell'] },
  env: { finding: null, valueOptions: ['-u', '--unset', '-C', '--chdir', '-S'], check: envCheck, whenEmpty: medium('env: 환경 변수 출력(비밀 정보 포함 가능)') },
  nohup: { finding: null, valueOptions: [] },
  timeout: { finding: null, valueOptions: ['-s', '--signal', '-k', '--kill-after'], skipPositional: 1 },
  nice: { finding: null, valueOptions: ['-n', '--adjustment'] },
  ionice: { finding: null, valueOptions: ['-c', '-n', '-p', '--class', '--classdata', '--pid'], check: ionicePrefix },
  time: { finding: null, valueOptions: ['-f', '-o', '--format', '--output'], check: timePrefix },
  command: { finding: null, valueOptions: [] },
  exec: { finding: null, valueOptions: ['-a'] },
  stdbuf: { finding: null, valueOptions: ['-i', '-o', '-e'] },
  xargs: { finding: null, valueOptions: ['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file'] },
  watch: { finding: medium('watch: 끝나지 않는 명령'), valueOptions: ['-n', '--interval'] }
}

/** Words of the command a wrapper runs, after its own options */
function stripWrapper(name, args) {
  const { valueOptions, skipPositional = 0 } = WRAPPERS[name]
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--') { i++; break }
    if (name === 'env' && ASSIGNMENT.test(arg)) { i++; continue }
    if (arg.startsWith('-')) { i += valueOptions.includes(arg) ? 2 : 1; continue }
    break
  }
  return args.slice(i + skipPositional)
}

module.exports = {
  LOW, MEDIUM, DANGER, FORBIDDEN, low, medium, danger, forbidden,
  LOW_COMMANDS, DANGER_REASONS, FORBIDDEN_COMMANDS, RULES, WRAPPERS, ASSIGNMENT, assignmentFinding, stripWrapper
}
