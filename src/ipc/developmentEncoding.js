const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { isUtf8 } = require('node:buffer')
const path = require('node:path')
const { isLocalFilePath } = require('../localKeyPath.js')

const run = promisify(execFile)
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true })
const literalReplacement = Buffer.from('\ufffd')
const MODES = new Set(['auto', 'utf-8', 'ms949'])

function validateLogEncoding(value = 'auto') {
  if (!MODES.has(value)) throw new Error('로그 인코딩을 확인해 주세요.')
  return value
}

// Leave a possibly complete UTF-8 character for the next raw PTY packet.
function utf8Boundary(data) {
  let start = data.length - 1
  while (start > 0 && data.length - start <= 3 && (data[start] & 0xc0) === 0x80) start--
  const lead = data[start]
  const width = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0
  return width > data.length - start ? start : data.length
}

function brokenUtf8(data, text) {
  let errors = 0
  if (isUtf8(data)) return errors
  for (const character of text) if (character === '\ufffd') errors++
  for (let position = data.indexOf(literalReplacement); position >= 0; position = data.indexOf(literalReplacement, position + 3)) errors--
  return errors
}

function createLogDecoder(mode = 'auto') {
  let decoder = mode === 'auto' ? null : new TextDecoder(mode === 'ms949' ? 'euc-kr' : 'utf-8', { ignoreBOM: true })
  let tail = Buffer.alloc(0)
  let suspect = Buffer.alloc(0)

  function write(chunk) {
    // ConPTY emits Unicode after applying the console code page. The original bytes
    // are only available from Unix PTYs opened with encoding: null.
    if (typeof chunk === 'string') return chunk
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (decoder) return decoder.decode(data, { stream: true })
    if (!data.length) return ''
    const bytes = tail.length ? Buffer.concat([tail, data]) : data
    const boundary = utf8Boundary(bytes)
    tail = bytes.subarray(boundary)
    const complete = bytes.subarray(0, boundary)
    if (!complete.length) return ''
    const text = utf8.decode(complete)
    const errors = brokenUtf8(complete, text)
    if (errors + Number(suspect.length > 0) >= 2) {
      decoder = new TextDecoder('euc-kr', { ignoreBOM: true })
      const fallback = Buffer.concat([suspect, bytes])
      suspect = tail = Buffer.alloc(0)
      return decoder.decode(fallback, { stream: true })
    }
    if ((errors || (suspect.length && tail.length)) && suspect.length + complete.length <= 4096) {
      suspect = Buffer.concat([suspect, complete])
      return ''
    }
    const prefix = suspect.length ? utf8.decode(suspect) : ''
    suspect = Buffer.alloc(0)
    return prefix + text
  }

  return { write, finish: () => decoder ? decoder.decode() : utf8.decode(Buffer.concat([suspect, tail])) }
}

const javaCharset = mode => mode === 'ms949' ? 'MS949' : 'UTF-8'

function windowsConsoleEncoding(mode) {
  if (mode === 'ms949') return '[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(949)'
  if (mode === 'utf-8') return '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)'
  return ''
}

function javaLogOptions(mode, feature) {
  if (mode === 'auto') return []
  const charset = javaCharset(mode)
  const prefix = feature && feature < 18 ? 'sun.' : ''
  return [`-D${prefix}stdout.encoding=${charset}`, `-D${prefix}stderr.encoding=${charset}`,
    // When a system launcher version can't be identified, cover both Java property generations.
    ...(!feature ? [`-Dsun.stdout.encoding=${charset}`, `-Dsun.stderr.encoding=${charset}`] : [])]
}

function javaVersionProbe() {
  const pending = new Map()
  return async (javaHome, env, cwd) => {
    const home = javaHome ?? Object.entries(env).find(([key]) => key.toUpperCase() === 'JAVA_HOME')?.[1] ?? process.env.JAVA_HOME
    const executable = process.platform === 'win32' ? 'java.exe' : 'java'
    const binary = home && isLocalFilePath(home) ? path.join(home, 'bin', executable) : executable
    const envPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1]
    const key = JSON.stringify([binary, envPath])
    if (!pending.has(key)) {
      if (pending.size >= 32) pending.delete(pending.keys().next().value)
      const options = { ...process.env, ...env }
      for (const name of Object.keys(options)) if (/^(?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/i.test(name)) delete options[name]
      pending.set(key, run(binary, ['-version'], { cwd, env: options, timeout: 2500, windowsHide: true, maxBuffer: 8192 })
        .then(({ stdout, stderr }) => Number(/\bversion\s+"(?:1\.)?(\d+)/i.exec(`${stdout}\n${stderr}`)?.[1]) || null).catch(() => null))
    }
    return pending.get(key)
  }
}

module.exports = { validateLogEncoding, createLogDecoder, javaCharset, javaLogOptions, javaVersionProbe, windowsConsoleEncoding }
