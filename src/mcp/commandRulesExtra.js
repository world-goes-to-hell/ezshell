// Per-command rules for commands whose arguments decide the risk (git, docker, sed, curl, ...).
// Shared helpers live here too so commandRules.js stays small. A rule receives the words after
// the command name and returns a finding: { level, reason? }.

const allow = require('./commandAllowlists.js')

const { LOW, MEDIUM, DANGER, FORBIDDEN, low, medium, danger, forbidden, hasFlag, positional, startsWithAny, longOptionMatches } = allow

const followCheck = (args, label) => (hasFlag(args, 'f', ['--follow']) ? medium(`${label} -f: 끝나지 않는 명령`) : low())

/**
 * Splits `args` into the subcommand and the words after it. Option words before the subcommand
 * are unsafe unless listed in `safe` ({ option: takesValue }); then `unsafe` holds the first one.
 */
function splitSubcommand(args, safe) {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) {
    const arg = args[i]
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const key = eq > 0 ? arg.slice(0, eq) : arg
    if (!Object.prototype.hasOwnProperty.call(safe, key)) return { unsafe: arg }
    i += safe[key] && key === arg ? 2 : 1
  }
  return { sub: args[i], rest: args.slice(i + 1) }
}

const unsafeLeading = (name, arg) => danger(`${name} ${arg}: 하위 명령 앞의 옵션은 동작을 바꿀 수 있음`)

const SYSTEMCTL_READ = new Set(['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files',
  'list-timers', 'list-sockets', 'list-dependencies', 'show', 'cat'])
const SYSTEMCTL_FORBIDDEN = new Set(['reboot', 'poweroff', 'halt', 'kexec', 'emergency', 'rescue'])
function systemctlRule(args) {
  const { sub, unsafe } = splitSubcommand(args, { '--no-pager': false, '--user': false })
  if (unsafe) return unsafeLeading('systemctl', unsafe)
  if (hasFlag(args, 'HM', ['--host', '--machine'])) return danger('systemctl: 다른 호스트·컨테이너 대상')
  if (!sub || SYSTEMCTL_READ.has(sub)) return low()
  if (SYSTEMCTL_FORBIDDEN.has(sub)) return forbidden(`systemctl ${sub}: 시스템 종료·재부팅`)
  return danger(`systemctl ${sub}: 서비스 상태 변경`)
}

const COMPOSE_SAFE = { '-f': true, '--file': true, '-p': true, '--project-name': true }
const COMPOSE_READ = new Set(['ps', 'logs', 'config', 'images', 'top', 'ls', 'version'])
function composeRule(args) {
  const { sub, rest, unsafe } = splitSubcommand(args, COMPOSE_SAFE)
  if (unsafe) return unsafeLeading('docker compose', unsafe)
  if (COMPOSE_READ.has(sub)) return followCheck(rest, `docker compose ${sub}`)
  return danger(`docker compose ${sub || ''}: 컨테이너 변경`.trim())
}

const DOCKER_READ = new Set(['ps', 'logs', 'images', 'inspect', 'stats', 'top', 'version', 'info', 'port', 'history', 'diff'])
const DOCKER_OBJECTS = new Set(['container', 'image', 'volume', 'network', 'node', 'service'])
const DOCKER_OBJECT_READ = new Set(['ls', 'list', 'ps', 'inspect', 'logs', 'top', 'port', 'history'])
function dockerRule(args) {
  const { sub, rest, unsafe } = splitSubcommand(args, {})
  if (unsafe) return unsafeLeading('docker', unsafe)
  if (sub === 'compose') return composeRule(rest)
  if (DOCKER_OBJECTS.has(sub)) {
    const sub2 = positional(rest)[0]
    return DOCKER_OBJECT_READ.has(sub2)
      ? followCheck(args, `docker ${sub} ${sub2}`)
      : danger(`docker ${sub} ${sub2 || ''}: 컨테이너·이미지 변경`.trim())
  }
  if (sub === 'stats' && !args.includes('--no-stream')) return medium('docker stats: 끝나지 않는 명령 (--no-stream 필요)')
  if (DOCKER_READ.has(sub)) return followCheck(args, `docker ${sub}`)
  return danger(`docker ${sub || ''}: 컨테이너·이미지 변경`.trim())
}

const KUBECTL_SAFE = { '-n': true, '--namespace': true, '--context': true }
const KUBECTL_READ = new Set(['get', 'describe', 'logs', 'top', 'version', 'explain', 'api-resources', 'api-versions', 'cluster-info'])
const KUBECTL_FOLLOW = ['--watch', '--watch-only', '--follow']
const kubectlFollow = (rest, sub) => (hasFlag(rest, 'wf', KUBECTL_FOLLOW)
  ? medium(`kubectl ${sub} -w/-f: 끝나지 않는 명령`)
  : low())
function kubectlRule(args) {
  const { sub, rest, unsafe } = splitSubcommand(args, KUBECTL_SAFE)
  if (unsafe) return unsafeLeading('kubectl', unsafe)
  if (sub === 'config') {
    const sub2 = positional(rest)[0]
    if (sub2 === 'view') return medium('kubectl config view: 인증 정보 포함 가능')
    if (sub2 === 'get-contexts' || sub2 === 'current-context') return low()
  }
  if (KUBECTL_READ.has(sub)) return kubectlFollow(rest, sub)
  return danger(`kubectl ${sub || ''}: 클러스터 변경`.trim())
}

const GIT_SAFE = { '-C': true, '--no-pager': false }
const GIT_READ = new Set(['log', 'status', 'diff', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog', 'grep', 'cat-file'])
const BRANCH_OPTIONS = new Set(['-a', '-r', '-v', '-vv', '-l', '--list', '--all', '--remotes', '--verbose', '--show-current'])
const BRANCH_VALUE_OPTIONS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--sort'])
const TAG_OPTIONS = new Set(['-l', '--list', '-n'])

/** True when every word is an allowed option (or the value of a value option) and there is no other word */
function onlyOptions(rest, options, valueOptions = new Set()) {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    const key = arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    if (valueOptions.has(key)) {
      if (key === arg) i++
      continue
    }
    if (!options.has(arg)) return false
  }
  return true
}

function gitReadRule(sub, rest) {
  if (['log', 'diff', 'show', 'shortlog'].includes(sub) && rest.some(arg => longOptionMatches(arg, '--output') || longOptionMatches(arg, '--ext-diff'))) {
    return danger(`git ${sub}: 파일 쓰기·외부 프로그램 실행 옵션`)
  }
  return low()
}

function gitRule(args) {
  const { sub, rest, unsafe } = splitSubcommand(args, GIT_SAFE)
  if (unsafe) return unsafeLeading('git', unsafe)
  if (sub === 'grep') return allow.gitGrepRule(rest)
  if (GIT_READ.has(sub)) return gitReadRule(sub, rest)
  if (sub === 'branch' && onlyOptions(rest, BRANCH_OPTIONS, BRANCH_VALUE_OPTIONS)) return low()
  if (sub === 'tag' && onlyOptions(rest, TAG_OPTIONS, new Set(['--sort']))) return low()
  if (sub === 'remote' && rest.every(arg => arg === '-v' || arg === '--verbose')) return low()
  if (sub === 'stash' && rest.length === 0) return danger('git stash: 작업 내용 보관')
  if (sub === 'stash' && rest.length === 1 && ['list', 'show'].includes(rest[0])) return low()
  if (sub === 'config' && hasFlag(rest, 'l', ['--list', '--get', '--get-all', '--get-regexp'])) return low()
  return danger(`git ${sub || ''}: 저장소 변경`.trim())
}

const TAR_SHORT = /^[tvzjJf]+$/
const TAR_LONG = new Set(['--list', '--verbose', '--gzip', '--bzip2', '--xz', '--file'])
const TAR_UNSAFE = 'tar: 묶기·풀기·외부 프로그램 실행 가능'
function tarRule(args) {
  if (args.some(arg => arg.includes(':'))) return danger('tar: 원격 아카이브(rsh·ssh) 사용 가능')
  let listing = false
  for (const [index, arg] of args.entries()) {
    const oldStyle = index === 0 && !arg.startsWith('-')
    if (arg.startsWith('--')) {
      const key = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
      if (!TAR_LONG.has(key)) return danger(TAR_UNSAFE)
      listing = listing || key === '--list'
    } else if (arg.startsWith('-') || oldStyle) {
      const letters = oldStyle ? arg : arg.slice(1)
      if (!TAR_SHORT.test(letters)) return danger(TAR_UNSAFE)
      listing = listing || letters.includes('t')
    }
  }
  return listing ? low() : danger('tar: 묶기·풀기')
}

const IP_OPTIONS = new Set(['-4', '-6', '-s', '-d', '-br', '-brief', '-c', '-color', '-j', '-json', '-p', '-pretty', '-o', '-oneline', '-h', '-human'])
const IP_OBJECTS = new Set(['addr', 'a', 'address', 'route', 'r', 'ro', 'link', 'l', 'neigh', 'n', 'neighbor', 'neighbour', 'rule', 'ru', 'maddr'])
const IP_VERBS = new Set(['show', 'sh', 'sho', 'list', 'ls', 'lst', 'get'])
function ipRule(args) {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) {
    if (!IP_OPTIONS.has(args[i])) return danger(`ip ${args[i]}: 네트워크 설정 변경 가능`)
    i++
  }
  if (!IP_OBJECTS.has(args[i])) return danger(`ip ${args[i] || ''}: 네트워크 설정 변경 가능`.trim())
  return args[i + 1] === undefined || IP_VERBS.has(args[i + 1]) ? low() : danger(`ip ${args[i]} ${args[i + 1]}: 네트워크 설정 변경`)
}

const DATE_VALUE_OPTIONS = new Set(['-d', '-r', '-f', '--date', '--reference', '--file'])
const DATE_SET = 'date: 시스템 시간 변경'
function dateRule(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (DATE_VALUE_OPTIONS.has(arg)) { i++; continue }
    if (arg.startsWith('--')) {
      if (longOptionMatches(arg, '--set')) return danger(DATE_SET)
    } else if (arg.startsWith('-')) {
      if (arg.includes('s')) return danger(DATE_SET)
    } else if (!arg.startsWith('+')) {
      return danger(DATE_SET)
    }
  }
  return low()
}

const PAGER_WRITE = ['--log-file', '--LOG-FILE']
const pagerRule = (name) => (args) => {
  if (args.some(arg => arg.startsWith('+') && arg.includes('!'))) return danger(`${name}: 시작 명령으로 셸 실행`)
  return optionRule(name, 'oO', PAGER_WRITE, '파일 쓰기')(args)
}
/** Operands: non-option words, a lone '-', and every word after '--' */
function dashPositional(args) {
  const end = args.indexOf('--')
  const before = end < 0 ? args : args.slice(0, end)
  return [...before.filter(arg => !arg.startsWith('-') || arg === '-'), ...(end < 0 ? [] : args.slice(end + 1))]
}
const dmesgWrite = () => optionRule('dmesg', 'CcnDE', ['--clear', '--read-clear', '--console-level', '--console-off', '--console-on'], '커널 로그·콘솔 설정 변경')
function dmesgRule(args) {
  const finding = dmesgWrite()(args)
  if (finding.level !== LOW) return finding
  return hasFlag(args, 'wW', ['--follow', '--follow-new']) ? medium('dmesg -w: 끝나지 않는 명령') : low()
}
const firstWord = (args) => positional(args)[0]
const optionRule = (name, shortLetters, longPrefixes, reason) => (args) => (
  hasFlag(args, shortLetters) || longPrefixes.some(name => args.some(arg => longOptionMatches(arg, name))) ? danger(`${name}: ${reason}`) : low()
)
const TIMEDATECTL_READ = ['status', 'show', 'list-timezones', 'timesync-status', 'show-timesync']

const EXTRA_RULES = {
  systemctl: systemctlRule,
  journalctl: allow.journalctlRule,
  docker: dockerRule,
  'docker-compose': composeRule,
  kubectl: kubectlRule,
  git: gitRule,
  tar: tarRule,
  ip: ipRule,
  sed: allow.sedRule,
  awk: allow.awkRule,
  gawk: allow.awkRule,
  mawk: allow.awkRule,
  nawk: allow.awkRule,
  curl: allow.curlRule,
  date: dateRule,
  sort: optionRule('sort', 'o', ['--output', '--compress-program'], '파일 쓰기·외부 프로그램 실행'),
  tree: optionRule('tree', 'oR', [], '파일 쓰기'),
  yq: optionRule('yq', 'is', ['--inplace', '--split-exp'], '파일 수정'),
  file: optionRule('file', 'C', ['--compile'], '파일 쓰기'),
  less: pagerRule('less'),
  more: pagerRule('more'),
  ss: optionRule('ss', 'KD', ['--kill', '--diag'], '연결 강제 종료'),
  lastlog: optionRule('lastlog', 'CS', ['--clear', '--set'], '기록 변경'),
  dmesg: dmesgRule,
  uniq: (args) => (dashPositional(args).length >= 2 ? danger('uniq: 출력 파일에 쓰기') : low()),
  xxd: (args) => (dashPositional(args).length >= 2 ? danger('xxd: 출력 파일에 쓰기') : low()),
  hostname: (args) => (positional(args).length > 0 || hasFlag(args, 'Fb', ['--file', '--boot']) ? danger('hostname: 호스트 이름 변경') : low()),
  hostnamectl: (args) => (!firstWord(args) || firstWord(args) === 'status' ? low() : danger('hostnamectl: 호스트 설정 변경')),
  timedatectl: (args) => (!firstWord(args) || TIMEDATECTL_READ.includes(firstWord(args)) ? low() : danger('timedatectl: 시간 설정 변경')),
  ps: (args) => (args.some(arg => !arg.startsWith('-') && arg.includes('e'))
    ? medium('ps e: 환경 변수 출력(비밀 정보 포함 가능)')
    : low())
}

module.exports = { EXTRA_RULES }
