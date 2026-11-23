const fs = require('node:fs')
const path = require('node:path')

const { EZSHELL_TEST_AGY_PROFILE: profile, EZSHELL_TEST_AGY_PANE: pane, EZSHELL_TEST_AGY_SETTINGS: settings } = process.env
const file = name => path.join(profile, `${pane}-agy-${name}`)
const session = pane === '1' ? 'c718ff33-8123-4022-9d6b-a5378ef4b2e0' : '730cf911-aeca-4a90-b73c-441b81967e8b'
const decoy = path.join(profile, 'outside-transcript.jsonl')
const logs = path.join(process.env.USERPROFILE, '.gemini', 'antigravity-cli', 'brain', session, '.system_generated', 'logs')
const transcript = path.join(logs, 'transcript_full.jsonl')
const { statusLine } = JSON.parse(fs.readFileSync(settings, 'utf8'))
fs.writeFileSync(file('status-command'), statusLine.command)
const rule = '─'.repeat(24)
const osc = state => `\x1b]7501;state=${state}:app=antigravity\x07`
let assigned = false
let blocked = false
let draft = ''
let keysRead = 0
let step = 0
const reports = []
let reportsRead = 0

function draw() {
  const prompt = blocked ? 'Choose how to proceed\r\n> 1. Continue\r\n  2. Cancel\r\n' : ''
  const row = blocked ? 6 : 3
  const footer = blocked ? '↑/↓ Navigate · enter Select · esc Skip' : `${draft ? '' : '? for shortcuts  '}Gemini 3.8 Flash · high`
  process.stdout.write(`\x1b[2J\x1b[Hfixture ready: antigravity ${pane}\r\n${prompt}${rule}\r\n> ${draft}\r\n${rule}\r\n${footer}\x1b[${row};${3 + draft.length}H`)
}

function report(state) {
  const sequence = reports.push(state)
  const request = file(`status-request-${sequence}`)
  fs.writeFileSync(request + '.tmp', JSON.stringify({
    product: 'antigravity', cwd: process.cwd(), session_id: assigned ? session : '', conversation_id: assigned ? session : '',
    transcript_path: decoy, agent_state: state
  }))
  fs.renameSync(request + '.tmp', request)
}

function record(source, type, content) {
  fs.mkdirSync(logs, { recursive: true })
  fs.appendFileSync(transcript, JSON.stringify({
    step_index: step++, source, type, content, status: 'DONE', created_at: new Date().toISOString()
  }) + '\n')
}

function takeKey(data) {
  if (blocked) {
    if (data === '1') {
      fs.writeFileSync(file('confirmed'), data)
      blocked = false
      draw()
      process.stdout.write(osc('idle'))
      report('idle')
    }
    return
  }
  if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) {
    draft = data.slice(6, -6)
    draw()
    return
  }
  if (data !== '\r' || !draft) return
  fs.appendFileSync(file('received'), JSON.stringify(draft) + '\n')
  assigned = true
  record('USER_EXPLICIT', 'USER_INPUT', draft)
  draft = ''
  draw()
  process.stdout.write(osc('working'))
  report('working')
}

process.stdout.write('\x1b]7501;?\x07\x1b[?2004h')
draw()
fs.writeFileSync(file('ready'), '')
process.stdout.write(osc('idle'))
report('idle')
setInterval(() => {
  const result = file(`status-result-${reportsRead + 1}`)
  if (fs.existsSync(result)) {
    const [code, stdout, stderr] = fs.readFileSync(result, 'utf8').trimEnd().split(/\r?\n/)
    fs.appendFileSync(file('reports'), JSON.stringify({ state: reports[reportsRead++], code: Number(code), stdout, stderr }) + '\n')
  }
  if (fs.existsSync(file('keys'))) {
    const bytes = fs.readFileSync(file('keys'), 'utf8')
    const complete = bytes.lastIndexOf('\n') + 1
    for (const line of bytes.slice(keysRead, complete).split('\n').filter(Boolean)) takeKey(JSON.parse(line))
    keysRead = complete
  }
  if (!fs.existsSync(file('action'))) return
  const action = fs.readFileSync(file('action'), 'utf8')
  if (!action) return
  fs.unlinkSync(file('action'))
  if (action === 'finish') {
    record('MODEL', 'PLANNER_RESPONSE', `Answer from Antigravity pane ${pane}.`)
    process.stdout.write(osc('idle'))
    report('idle')
  } else if (action === 'block') {
    blocked = true
    draw()
    process.stdout.write(osc('blocked:kind=question'))
    // Real 1.5.4 may leave the status line idle without tool_confirmation_pending during a question.
    report('idle')
  } else if (action === 'draft') {
    draft = 'typed in the terminal'
    draw()
  } else if (action === 'clear') {
    draft = ''
    draw()
  } else if (action === 'exit') {
    fs.writeFileSync(file('ended'), '')
    process.stdout.write(osc('idle') + '\x1b[?2004l')
    process.exit(0)
  }
}, 40)
