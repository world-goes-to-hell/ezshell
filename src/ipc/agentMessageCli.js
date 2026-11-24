const net = require('net')
const { parseArgs } = require('util')

const usage = `ezshell agent list --json
ezshell message send --to <agent-id> --text <text> [--request-id <id>]
ezshell message inbox [--unread] [--wait] --json
ezshell message ack --id <message-id>
ezshell message reply --reply-to <message-id> --text <text>
Use --stdin instead of --text for multiline messages.`

async function stdinText() {
  let value = ''
  process.stdin.setEncoding('utf8')
  for await (const data of process.stdin) {
    value += data
    if (value.length > 8000) throw new Error('메시지를 1~8000자로 입력해 주세요.')
  }
  return value.trimEnd()
}

function rpc(request, { pipe = process.env.EZSHELL_AGENT_PIPE, token = process.env.EZSHELL_AGENT_TOKEN, signal } = {}) {
  if (!pipe || !token) throw new Error('ezShell에서 시작한 에이전트의 터미널에서 실행해 주세요.')
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const socket = net.createConnection(pipe)
    if (signal) {
      const abort = () => socket.destroy(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      socket.once('close', () => signal.removeEventListener('abort', abort))
    }
    socket.setEncoding('utf8')
    socket.setTimeout(request.method === 'wait-inbox' ? 35000 : 5000, () => socket.destroy(new Error('ezShell 응답이 지연되고 있습니다.')))
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ ...request, token }) + '\n'))
    let data = ''
    socket.on('data', chunk => { data += chunk })
    socket.on('end', () => {
      try { resolve(JSON.parse(data)) } catch { reject(new Error('ezShell 응답을 읽을 수 없습니다.')) }
    })
  })
}

async function main() {
  const [group, command, ...args] = process.argv.slice(2)
  if (!group || process.argv.includes('--help')) {
    console.log(usage)
    return
  }
  const { values } = parseArgs({
    args,
    options: {
      json: { type: 'boolean' }, to: { type: 'string' }, text: { type: 'string' },
      stdin: { type: 'boolean' }, 'reply-to': { type: 'string' }, 'request-id': { type: 'string' },
      id: { type: 'string' }, unread: { type: 'boolean' }, wait: { type: 'boolean' }
    }
  })
  let request
  if (group === 'agent' && command === 'list') request = { method: 'list' }
  else if (group === 'message' && command === 'inbox') request = { method: values.wait ? 'wait-inbox' : 'inbox', unread: values.unread }
  else if (group === 'message' && command === 'ack') request = { method: 'ack', id: values.id }
  else if (group === 'message' && (command === 'send' || (command === 'reply' && values['reply-to']))) {
    request = {
      method: 'send', to: values.to, replyTo: values['reply-to'], requestId: values['request-id'],
      text: values.stdin ? await stdinText() : values.text
    }
  } else throw new Error(usage)
  const result = await rpc(request)
  console.log(JSON.stringify(result, null, values.json ? 0 : 2))
  if (!result.success) process.exitCode = 1
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = { rpc }
