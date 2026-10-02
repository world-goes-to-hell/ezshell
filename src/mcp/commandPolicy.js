// Decides how risky a shell command line is before the MCP server runs it.
// This guards against mistakes, not a determined attacker: when in doubt it errs high,
// and the approval dialog plus the audit log are the final safety net.
const { parseCommand } = require('./shellParse.js')
const rules = require('./commandRules.js')

const { LOW, MEDIUM, DANGER, FORBIDDEN, low, medium, danger, forbidden } = rules

const LEVEL_ORDER = [LOW, MEDIUM, DANGER, FORBIDDEN]
const ALERT_THRESHOLDS = { all: LOW, medium: MEDIUM, danger: DANGER }
const MAX_DEPTH = 5
const FORK_BOMB = /(\w+|:)\s*\(\s*\)\s*\{[^}]*\1\s*\|\s*&?\s*\1/
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>'])
const TRUSTED_DIRS = new Set(['/bin/', '/usr/bin/', '/sbin/', '/usr/sbin/', '/usr/local/bin/', '/usr/local/sbin/'])
const DISK_DEVICE = /^\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|disk)/
const SENSITIVE_PATHS = [
  /(^|\/)\.env(\.|$)/,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)/,
  /(^|\/)\.ssh(\/|$)/,
  /^\/etc\/(shadow|gshadow|sudoers)/,
  /(^|\/)\.pgpass$/,
  /(^|\/)\.my\.cnf$/,
  /(^|\/)application[^/]*\.(ya?ml|properties)$/,
  /(^|\/)\.kube\/config$/,
  /^\/proc\/[^/]+\/environ$/,
  /credential/i,
  /secret/i
]

const rank = (level) => LEVEL_ORDER.indexOf(level)

function sensitiveFindings(values) {
  return values
    .filter(value => SENSITIVE_PATHS.some(pattern => pattern.test(value)))
    .map(value => medium(`비밀 정보가 있을 수 있는 경로: ${value}`))
}

function classifyName(name, args) {
  if (rules.FORBIDDEN_COMMANDS.has(name)) return forbidden(`${name}: ${rules.FORBIDDEN_COMMANDS.get(name)}`)
  if (name.startsWith('mkfs')) return forbidden(`${name}: 파일시스템 포맷`)
  if (rules.RULES[name]) return rules.RULES[name](args, name)
  if (rules.DANGER_REASONS.has(name)) return danger(`${name}: ${rules.DANGER_REASONS.get(name)}`)
  if (rules.LOW_COMMANDS.has(name)) return low()
  return danger(`${name}: 처음 보는 명령`)
}

/** Turns a nested classification into a finding that carries its own risk level */
function nestedFinding(result, label) {
  return {
    level: result.level,
    reason: result.reasons.length > 0 ? `${label}: ${result.reasons.join(', ')}` : undefined
  }
}

/** Name to look up for a command word; a path outside the trusted directories is dangerous */
function resolveName(raw) {
  const slash = raw.lastIndexOf('/')
  if (slash === -1) return { name: raw }
  const name = raw.slice(slash + 1)
  if (TRUSTED_DIRS.has(raw.slice(0, slash + 1))) return { name }
  return { name, finding: danger(`${raw}: 경로로 실행하는 파일`) }
}

function classifyWrapper(name, args, depth) {
  const wrapper = rules.WRAPPERS[name]
  const findings = wrapper.finding ? [wrapper.finding] : []
  const inner = rules.stripWrapper(name, args)
  const prefix = args.slice(0, args.length - inner.length)
  if (wrapper.check) findings.push(...wrapper.check(prefix))
  if (inner.length === 0) return [...findings, wrapper.whenEmpty || low()]
  // watch runs its command through `sh -c`, so the joined words are a full command line
  const viaShell = name === 'watch' && !prefix.some(arg => arg === '-x' || arg === '--exec')
  if (viaShell) return [...findings, nestedFinding(classifyCommand(inner.join(' '), depth + 1), 'watch 안')]
  return [...findings, ...classifyWords(inner, depth)]
}

function classifyWords(words, depth = 0) {
  let start = 0
  const findings = []
  while (start < words.length && rules.ASSIGNMENT.test(words[start])) {
    findings.push(rules.assignmentFinding(words[start]))
    start++
  }
  const [raw, ...args] = words.slice(start)
  if (raw === undefined) return findings.filter(Boolean).concat(low())

  const { name, finding: pathFinding } = resolveName(raw)
  findings.push(...sensitiveFindings(args))
  if (pathFinding) findings.push(pathFinding)
  if (rules.WRAPPERS[name]) return [...findings.filter(Boolean), ...classifyWrapper(name, args, depth)]
  findings.push(classifyName(name, args))
  return findings.filter(Boolean)
}

function classifyRedirect({ op, target }) {
  if (op === 'dup') return low()
  if (WRITE_REDIRECTS.has(op)) {
    if (target === '/dev/null') return low()
    if (target === '/proc/sysrq-trigger') return forbidden('sysrq-trigger에 쓰기: 시스템 강제 종료·재부팅')
    if (DISK_DEVICE.test(target)) return forbidden(`디스크 장치에 직접 쓰기: ${target}`)
    return danger(`파일에 쓰기: ${op} ${target}`)
  }
  if (op === '<>') return danger(`파일을 읽기·쓰기로 열기: ${target}`)
  return sensitiveFindings([target])[0] || low()
}

function summarize(findings) {
  const level = findings.reduce((max, finding) => (rank(finding.level) > rank(max) ? finding.level : max), LOW)
  const reasons = findings
    .filter(finding => finding.reason)
    .sort((a, b) => rank(b.level) - rank(a.level))
    .map(finding => finding.reason)
  return { level, reasons: [...new Set(reasons)] }
}

function classifyCommand(input, depth = 0) {
  if (typeof input !== 'string' || input.trim() === '') return { level: DANGER, reasons: ['빈 명령'] }
  if (depth > MAX_DEPTH) return { level: DANGER, reasons: ['명령 치환이 너무 깊게 중첩됨'] }
  if (FORK_BOMB.test(input)) return { level: FORBIDDEN, reasons: ['포크 폭탄'] }

  const parsed = parseCommand(input)
  if (!parsed.ok) return { level: DANGER, reasons: [`명령을 해석할 수 없음: ${parsed.error}`] }

  const findings = []
  for (const segment of parsed.segments) {
    findings.push(...classifyWords(segment.words, depth))
    findings.push(...segment.redirects.map(classifyRedirect))
  }
  if (parsed.background) findings.push(danger('백그라운드 실행(&): 시간 제한 뒤에도 서버에 남음'))
  for (const substitution of parsed.substitutions) {
    const inner = classifyCommand(substitution, depth + 1)
    findings.push({
      level: inner.level,
      reason: inner.reasons.length > 0 ? `명령 치환 안: ${inner.reasons.join(', ')}` : undefined
    })
  }
  return summarize(findings)
}

function needsApproval(level, alertLevel) {
  if (level === FORBIDDEN) return false
  if (rank(level) === -1) return true
  const threshold = ALERT_THRESHOLDS[alertLevel] || LOW
  return rank(level) >= rank(threshold)
}

module.exports = { classifyCommand, needsApproval, sensitiveFindings, LEVEL_ORDER }
