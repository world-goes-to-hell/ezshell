// A shell-bound fixture drives the app's own stdio MCP server without an installed agent CLI.
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { createInterface } = require('node:readline')
const { setTimeout: delay } = require('node:timers/promises')

const [presetName, url, newerUrl, resultFile] = process.argv.slice(2)
const report = value => writeFileSync(resultFile, JSON.stringify(value))
report({ status: 'connecting' })
const child = spawn(process.env.EZSHELL_CLI_EXE, [process.env.EZSHELL_AGENT_MCP_SCRIPT], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', EZSHELL_AGENT_SHELL_KIND: 'claude' },
  windowsHide: true, stdio: ['pipe', 'pipe', 'inherit']
})
const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
let sequence = 0
const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
async function request(method, params) {
  send({ method, params, id: ++sequence })
  const reply = await replies.next()
  if (reply.done) throw new Error('Message MCP closed without a response')
  const response = JSON.parse(reply.value)
  if (response.error) throw new Error(response.error.message)
  return response.result
}

const tool = (name, args) => request('tools/call', { name, arguments: args })
const timeout = setTimeout(() => child.kill(), 80_000)

async function run() {
  await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'run-proposal-fixture', version: '1' } })
  send({ method: 'notifications/initialized' })

  // Stdio initialization completes before the app verifies the shell process and registers the agent.
  const registrationDeadline = Date.now() + 35_000
  let identity
  do {
    identity = await tool('list_agents', {})
    if (!identity.isError) break
    await delay(250)
  } while (Date.now() < registrationDeadline)
  if (identity.isError) throw new Error(`MCP did not register the shell-bound agent: ${identity.content[0].text}`)
  const { self: by } = JSON.parse(identity.content[0].text)
  if (!by) throw new Error('MCP registered without a shell-bound agent ID')
  report({ status: 'diagnosing', by })

  const read = () => tool('run_log', { name: presetName, errors: true })
  let suggestion
  let diagnosis
  const diagnosisDeadline = Date.now() + 10_000
  do {
    const result = await read()
    const response = result.content[0].text
    if (result.isError) {
      diagnosis = response
    } else {
      const { suggestions } = JSON.parse(response)
      diagnosis = suggestions.map(({ kind, proposalKind }) => ({ kind, proposalKind }))
      suggestion = suggestions.find(item => item.proposalKind === 'mavenMirror')
      if (suggestion && (response.includes('fixture-maven-secret') || !response.includes('password=****'))) {
        throw new Error('MCP error groups did not mask the fixture credential')
      }
    }
    if (suggestion) break
    await delay(250)
  } while (Date.now() < diagnosisDeadline)
  if (!suggestion) throw new Error(`MCP did not see a Maven replacement diagnosis: ${JSON.stringify(diagnosis)}`)
  const plain = await tool('run_log', { name: presetName })
  if (plain.isError || plain.content[0].text.includes('fixture-maven-secret') || !plain.content[0].text.includes('password=****')) {
    throw new Error('MCP log lines did not mask the fixture credential')
  }
  const propose = async (url, note) => {
    const result = await tool('run_propose', { name: presetName, suggestion: suggestion.suggestion, url, note })
    if (result.isError) throw new Error(result.content[0].text)
    return JSON.parse(result.content[0].text)
  }
  const initial = await propose(url, '테스트 미러 주소를 확인해 주세요. token=fixture-proposal-secret')
  const newer = await propose(newerUrl, '다른 미러도 검토해 주세요.')
  report({ ...initial, by, newer: newer.status })
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await read()
    if (!current.isError) {
      const proposals = JSON.parse(current.content[0].text).proposals
      const first = proposals.find(item => item.id === initial.id)
      const latest = proposals.find(item => item.id === newer.id)
      if (first && latest && first.status !== 'pending' && latest.status !== 'pending') {
        if (!first.note?.endsWith('token=****')) throw new Error('MCP proposal note did not mask the fixture credential')
        const inbox = await tool('read_inbox', { unread_only: true })
        if (inbox.isError) throw new Error(inbox.content[0].text)
        const handoff = JSON.parse(inbox.content[0].text).messages.find(message => message.from === 'user')?.text
        report({ ...first, by, newer: latest.status, handoff })
        return
      }
    }
    await delay(250)
  }
  throw new Error('MCP did not see the user resolve the proposal')
}

const reportError = error => report({ status: 'error', error: error.message })
child.on('error', reportError)
run().catch(reportError).finally(() => {
  clearTimeout(timeout)
  child.stdin.end()
})
