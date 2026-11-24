const FIELDS = new Set(['hook_event_name', 'session_id', 'prompt_id', 'turn_id', 'tool_use_id', 'tool_name',
  'notification_type', 'stop_hook_active', 'source'])
// In-process subagents use the same terminal token. Detect their scope without reading their id.
const KEYS = [...FIELDS, 'agent_id']
const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
const LITERALS = { t: 'true', f: 'false', n: 'null' }
const SPACE = /^[ \t\r\n]$/
const DIGIT = /^[0-9]$/
const HEX = /^[0-9a-f]$/i
const MAX_TEXT = 100
const MAX_DEPTH = 256

function numberStep(state, ch) {
  if (state === 'sign') return ch === '0' ? 'zero' : DIGIT.test(ch) ? 'integer' : null
  if (state === 'dot') return DIGIT.test(ch) ? 'fraction' : null
  if (state === 'exponent') return ch === '+' || ch === '-' ? 'exponentSign' : DIGIT.test(ch) ? 'exponentDigits' : null
  if (state === 'exponentSign') return DIGIT.test(ch) ? 'exponentDigits' : null
  if (DIGIT.test(ch)) return state === 'zero' ? null : state
  if ((state === 'zero' || state === 'integer') && ch === '.') return 'dot'
  if ((state === 'zero' || state === 'integer' || state === 'fraction') && (ch === 'e' || ch === 'E')) return 'exponent'
  return null
}

function hookInputParser() {
  const fields = Object.create(null)
  const stack = []
  const seen = new Set()
  let root = false
  let invalid = false
  let subagent = false
  let token = null

  function startContainer(end) {
    if (stack.length === MAX_DEPTH) { invalid = true; return }
    stack.push({ end, next: end === '}' ? 'firstKey' : 'firstValue' })
  }

  function beginString(isKey, capture) {
    token = { type: 'string', isKey, capture, text: '', escape: false, hexLeft: 0, code: 0 }
  }

  function append(ch) {
    if (!token.capture) return
    const next = token.text + ch
    if (next.length > MAX_TEXT || (token.isKey && !KEYS.some(key => key.startsWith(next)))) {
      token.capture = null
      token.text = ''
    } else token.text = next
  }

  function closeString() {
    const { isKey, capture, text } = token
    token = null
    if (isKey) {
      const frame = stack.at(-1)
      frame.next = 'colon'
      frame.key = capture && FIELDS.has(text) ? text : undefined
      if (capture && text === 'agent_id') subagent = true
      if (frame.key) {
        if (seen.has(frame.key)) invalid = true
        seen.add(frame.key)
      }
    } else if (capture) fields[capture] = text
  }

  function stringChar(ch) {
    if (token.hexLeft) {
      if (!HEX.test(ch)) { invalid = true; return }
      token.code = token.code * 16 + parseInt(ch, 16)
      if (--token.hexLeft === 0) append(String.fromCharCode(token.code))
    } else if (token.escape) {
      token.escape = false
      if (ch === 'u') {
        token.hexLeft = 4
        token.code = 0
      } else if (Object.hasOwn(ESCAPES, ch)) append(ESCAPES[ch])
      else invalid = true
    } else if (ch === '"') closeString()
    else if (ch === '\\') token.escape = true
    else if (ch.charCodeAt(0) < 32) invalid = true
    else append(ch)
  }

  function beginValue(ch, key) {
    if (ch === '{' || ch === '[') startContainer(ch === '{' ? '}' : ']')
    else if (ch === '"') beginString(false, key === 'stop_hook_active' ? null : key)
    else if (Object.hasOwn(LITERALS, ch)) token = { type: 'literal', word: LITERALS[ch], index: 1, key }
    else if (ch === '-' || DIGIT.test(ch)) token = { type: 'number', state: ch === '-' ? 'sign' : ch === '0' ? 'zero' : 'integer' }
    else invalid = true
  }

  function structuralChar(ch) {
    if (SPACE.test(ch)) return
    const frame = stack.at(-1)
    if (!frame) {
      if (root || ch !== '{') { invalid = true; return }
      root = true
      startContainer('}')
      return
    }
    switch (frame.next) {
      case 'firstKey':
      case 'key':
        if (frame.next === 'firstKey' && ch === '}') stack.pop()
        else if (ch === '"') beginString(true, stack.length === 1)
        else invalid = true
        break
      case 'colon':
        if (ch === ':') frame.next = 'value'
        else invalid = true
        break
      case 'firstValue':
      case 'value':
        if (frame.next === 'firstValue' && ch === ']') stack.pop()
        else {
          frame.next = 'afterValue'
          beginValue(ch, frame.key)
        }
        break
      default:
        if (ch === frame.end) stack.pop()
        else if (ch === ',') frame.next = frame.end === '}' ? 'key' : 'value'
        else invalid = true
    }
  }

  function push(chunk) {
    for (let index = 0; index < chunk.length && !invalid; index++) {
      const ch = chunk[index]
      if (token?.type === 'string') {
        stringChar(ch)
        continue
      }
      if (token?.type === 'literal') {
        if (token.word[token.index++] !== ch) { invalid = true; continue }
        if (token.index === token.word.length) {
          if (token.key === 'stop_hook_active' && token.word !== 'null') fields[token.key] = token.word === 'true'
          token = null
        }
        continue
      }
      if (token?.type === 'number') {
        const next = numberStep(token.state, ch)
        if (next) { token.state = next; continue }
        if (!['zero', 'integer', 'fraction', 'exponentDigits'].includes(token.state)) { invalid = true; continue }
        token = null
      }
      structuralChar(ch)
    }
  }

  return {
    push,
    get complete() { return !invalid && root && stack.length === 0 && !token },
    finish(timedOut) {
      const complete = this.complete
      return invalid || (!complete && !timedOut) ? null : { fields, complete, ...(subagent ? { subagent: true } : {}) }
    }
  }
}

/** Check the full JSON syntax without assembling the input or saving values outside the allowlist. */
function readHookInput(input, timeoutMs = 1000) {
  const parser = hookInputParser()
  return new Promise(resolve => {
    const finish = result => {
      clearTimeout(timer)
      input.off('data', onData)
      input.off('end', onEnd)
      // Keep draining after the deadline. The reporter closes stdin once the RPC budget is spent.
      input.resume()
      resolve(result)
    }
    const onData = chunk => {
      parser.push(chunk)
      if (parser.complete) finish(parser.finish(false))
    }
    const onEnd = () => finish(parser.finish(false))
    const timer = setTimeout(() => finish(parser.finish(true)), timeoutMs)
    input.setEncoding('utf8')
    input.on('data', onData)
    input.once('end', onEnd)
    input.once('error', () => finish(null))
  })
}

module.exports = { readHookInput }
