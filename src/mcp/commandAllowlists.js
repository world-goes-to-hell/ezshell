// Option allowlists for commands where a denylist keeps leaking (GNU getopt_long accepts
// abbreviated long options, so `--in-pl` means `--in-place`). Any option that is not listed
// exactly is dangerous. Also holds the finding constructors and the abbreviation-aware helpers
// shared by all rule files.

const LOW = 'low'
const MEDIUM = 'medium'
const DANGER = 'danger'
const FORBIDDEN = 'forbidden'

const low = () => ({ level: LOW })
const medium = (reason) => ({ level: MEDIUM, reason })
const danger = (reason) => ({ level: DANGER, reason })
const forbidden = (reason) => ({ level: FORBIDDEN, reason })

/**
 * True when `arg` is `name` or an abbreviation of it (`--in-pl` for `--in-place`), with or
 * without `=value`. Any non-empty prefix counts, which errs toward matching.
 */
function longOptionMatches(arg, name) {
  if (!arg.startsWith('--') || arg === '--') return false
  const eq = arg.indexOf('=')
  const key = eq > 0 ? arg.slice(0, eq) : arg
  return key.length > 2 && name.startsWith(key)
}

/** True when any option word sets one of `shortLetters` or matches (or abbreviates) one of `longNames` */
function hasFlag(args, shortLetters, longNames = []) {
  return args.some(arg => {
    if (arg.startsWith('--')) return longNames.some(name => longOptionMatches(arg, name))
    return arg.startsWith('-') && arg.length > 1 && [...arg.slice(1)].some(ch => shortLetters.includes(ch))
  })
}

const positional = (args) => args.filter(arg => !arg.startsWith('-'))
const startsWithAny = (arg, prefixes) => prefixes.some(prefix => arg.startsWith(prefix))
const NUMBER = /^[-+]?\d+$/
const looksLikeValue = (word) => word !== undefined && (!word.startsWith('-') || NUMBER.test(word))

const FAIL = { ok: false, opts: [], positional: [], rest: [] }

/** Parses one cluster of short options; returns the index of the last word it used, or -1 when not allowed */
function parseCluster(args, index, spec, opts) {
  const letters = args[index].slice(1)
  for (let j = 0; j < letters.length; j++) {
    const ch = letters[j]
    const last = j === letters.length - 1
    if ((spec.flags || '').includes(ch)) {
      opts.push({ name: `-${ch}` })
    } else if ((spec.valueShort || '').includes(ch)) {
      if (last && index + 1 >= args.length) return -1
      opts.push({ name: `-${ch}`, value: last ? args[index + 1] : letters.slice(j + 1) })
      return last ? index + 1 : index
    } else if ((spec.optionalShort || '').includes(ch)) {
      const next = args[index + 1]
      const takeNext = last && looksLikeValue(next)
      opts.push({ name: `-${ch}`, value: last ? (takeNext ? next : undefined) : letters.slice(j + 1) })
      return takeNext ? index + 1 : index
    } else {
      return -1
    }
  }
  return index
}

/** Parses one long option; returns the index of the last word it used, or -1 when not allowed */
function parseLong(args, index, spec, opts) {
  const arg = args[index]
  const eq = arg.indexOf('=')
  const key = eq > 0 ? arg.slice(0, eq) : arg
  const has = (list) => (list || []).includes(key)
  if (has(spec.longFlags)) {
    if (eq > 0) return -1
    opts.push({ name: key })
    return index
  }
  if (has(spec.longValue)) {
    if (eq < 0 && index + 1 >= args.length) return -1
    opts.push({ name: key, value: eq > 0 ? arg.slice(eq + 1) : args[index + 1] })
    return eq > 0 ? index : index + 1
  }
  if (has(spec.longOptional)) {
    const takeNext = eq < 0 && looksLikeValue(args[index + 1])
    opts.push({ name: key, value: eq > 0 ? arg.slice(eq + 1) : (takeNext ? args[index + 1] : undefined) })
    return takeNext ? index + 1 : index
  }
  return -1
}

/**
 * Checks `args` against an option allowlist. `spec`: flags / valueShort / optionalShort (letters),
 * longFlags / longValue / longOptional (exact names), stopAtPositional, allowDashDash, passThrough(word).
 * Returns { ok, opts: [{ name, value? }], positional, rest }.
 */
function parseAllowlist(args, spec) {
  const opts = []
  const words = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    let used = i
    if (arg === '--') {
      if (!spec.allowDashDash) return FAIL
      return { ok: true, opts, positional: [...words, ...args.slice(i + 1)], rest: [] }
    }
    if (arg.startsWith('--')) used = parseLong(args, i, spec, opts)
    else if (arg.startsWith('-') && arg.length > 1) used = parseCluster(args, i, spec, opts)
    else if (spec.passThrough && spec.passThrough(arg)) continue
    else {
      words.push(arg)
      if (spec.stopAtPositional) return { ok: true, opts, positional: words, rest: args.slice(i + 1) }
      continue
    }
    if (used < 0) return FAIL
    i = used
  }
  return { ok: true, opts, positional: words, rest: [] }
}

const SPECS = {
  env: {
    flags: 'i0', valueShort: 'u', longFlags: ['--ignore-environment', '--null'], longValue: ['--unset'], allowDashDash: true
  },
  time: { flags: 'pv', longFlags: ['--portability', '--verbose'] },
  curl: {
    flags: 'sSLIivfkG46',
    valueShort: 'HmAeuX',
    longFlags: ['--silent', '--show-error', '--location', '--head', '--include', '--verbose', '--fail', '--insecure',
      '--get', '--compressed', '--http1.1', '--http2'],
    longValue: ['--header', '--max-time', '--connect-timeout', '--user-agent', '--referer', '--user', '--request']
  },
  awk: { valueShort: 'Fv', longValue: ['--field-separator', '--assign'], stopAtPositional: true },
  sed: {
    flags: 'nErszu',
    valueShort: 'e',
    longFlags: ['--quiet', '--silent', '--regexp-extended', '--separate', '--null-data', '--unbuffered'],
    longValue: ['--expression']
  },
  gitGrep: {
    flags: 'inwlLcEFPvhH',
    valueShort: 'eABC',
    longFlags: ['--ignore-case', '--line-number', '--count', '--word-regexp', '--files-with-matches', '--files-without-match',
      '--extended-regexp', '--fixed-strings', '--perl-regexp', '--invert-match']
  },
  journalctl: {
    flags: 'krxeaqf',
    valueShort: 'unpSUotg',
    optionalShort: 'b',
    longFlags: ['--dmesg', '--reverse', '--catalog', '--pager-end', '--no-pager', '--all', '--quiet', '--system', '--user',
      '--utc', '--no-hostname', '--list-boots', '--disk-usage', '--follow'],
    longValue: ['--unit', '--lines', '--priority', '--since', '--until', '--output', '--identifier', '--grep'],
    longOptional: ['--boot']
  }
}

const CURL_URL = /^https?:\/\//i
const CURL_METHODS = ['GET', 'HEAD']
function curlRule(args) {
  const parsed = parseAllowlist(args, SPECS.curl)
  if (!parsed.ok) return danger('curl: 허용 목록에 없는 옵션(파일 쓰기·데이터 전송·다른 프로토콜 가능)')
  if (parsed.positional.some(url => !CURL_URL.test(url))) return danger('curl: http·https 이외의 주소')
  const methods = parsed.opts.filter(opt => opt.name === '-X' || opt.name === '--request')
  const badMethod = methods.find(opt => !CURL_METHODS.includes(opt.value.toUpperCase()))
  if (badMethod) return danger(`curl: ${badMethod.value} 요청`)
  if (parsed.opts.some(opt => (opt.name === '-H' || opt.name === '--header') && opt.value.startsWith('@'))) {
    return danger('curl: @파일 헤더는 로컬 파일을 읽어 전송함')
  }
  return medium('curl: 외부로 요청')
}

const AWK_DANGER = /@|system\s*\(|\|\s*getline|\|&|\b(print|printf)\b[^;}]*[>|]/
function awkRule(args, name) {
  const parsed = parseAllowlist(args, SPECS.awk)
  if (!parsed.ok) return danger(`${name}: 허용 목록에 없는 옵션(프로그램이 보이지 않거나 외부 코드를 불러올 수 있음)`)
  // A backslash-newline (LF or CRLF) only continues the line; drop it so it cannot split a keyword
  const program = parsed.positional[0]?.replace(/\\\r?\n/g, '')
  if (program === undefined || AWK_DANGER.test(program)) return danger(`${name}: 프로그램 안에서 명령 실행·파일 쓰기`)
  return medium(`${name}: 프로그램 안에서 명령을 실행할 수 있음`)
}

const SED_UNSAFE = '스크립트에 파일 쓰기·명령 실행이 있을 수 있음'
const SED_COMMANDS = [
  /^\s*(\d+|\$)?(,(\d+|\$))?\s*[pdq]\s*$/,
  /^\s*\/[^/]*\/\s*[pd]\s*$/,
  /^\s*s(.)((?:(?!\1).)*)\1((?:(?!\1).)*)\1[gpiI0-9]*\s*$/
]
function sedRule(args) {
  const parsed = parseAllowlist(args, SPECS.sed)
  if (!parsed.ok) return danger(`sed: 허용 목록에 없는 옵션(-i·-f 등): ${SED_UNSAFE}`)
  const expressions = parsed.opts.filter(opt => opt.name === '-e' || opt.name === '--expression').map(opt => opt.value)
  const scripts = expressions.length > 0 ? expressions : [parsed.positional[0] || '']
  const commands = scripts.flatMap(script => script.split(/[;\n]/)).filter(command => command.trim() !== '')
  const safe = commands.length > 0 && commands.every(command => SED_COMMANDS.some(pattern => pattern.test(command)))
  return safe ? medium('sed: 내부 명령으로 파일 쓰기·실행 가능') : danger(`sed: ${SED_UNSAFE}`)
}

const gitGrepRule = (rest) => (parseAllowlist(rest, SPECS.gitGrep).ok ? low() : danger('git grep: 허용 목록에 없는 옵션(외부 프로그램 실행 가능)'))

function journalctlRule(args) {
  const parsed = parseAllowlist(args, SPECS.journalctl)
  if (!parsed.ok) return danger('journalctl: 허용 목록에 없는 옵션(키 생성·파일 쓰기·로그 정리 가능)')
  return parsed.opts.some(opt => opt.name === '-f' || opt.name === '--follow') ? medium('journalctl -f: 끝나지 않는 명령') : low()
}

module.exports = {
  LOW, MEDIUM, DANGER, FORBIDDEN, low, medium, danger, forbidden,
  longOptionMatches, hasFlag, positional, startsWithAny, parseAllowlist, SPECS,
  curlRule, awkRule, sedRule, gitGrepRule, journalctlRule
}
