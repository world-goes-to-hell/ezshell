// The JVM is started by the local run configuration and explicitly opts into loopback JDWP.
const net = require('node:net')

const HANDSHAKE = Buffer.from('JDWP-Handshake')
const HEADER_BYTES = 11
const MAX_PACKET_BYTES = 64 * 1024 * 1024
const REPLY = 0x80
const VM_COMMAND_SET = 1
const REDEFINE_TIMEOUT_MS = 60_000
const EMPTY = Buffer.alloc(0)
const closedError = () => new Error('JVM 디버그 연결이 닫혔습니다.')
const packetError = () => new Error('JVM 디버그 응답 형식이 올바르지 않습니다.')

const REASONS = new Map([
  [60, '클래스 형식 오류'], [61, '클래스 순환 참조'], [62, '클래스 검증 실패'],
  [63, '메서드 추가'], [64, '필드 변경'], [65, '클래스 상태 오류'], [66, '상속 변경'],
  [67, '메서드 삭제'], [68, '지원하지 않는 클래스 버전'], [69, '클래스 이름 불일치'],
  [70, '클래스 수정자 변경'], [71, '메서드 수정자 변경'], [72, '클래스 속성 변경']
])

class JdwpError extends Error {
  constructor(code, signature = null) {
    const reason = REASONS.get(code) ?? `JVM이 요청을 거부했습니다 (JDWP ${code}).`
    super(reason)
    this.name = 'JdwpError'
    this.code = code
    this.reason = reason
    this.signature = signature
  }
}

const int = value => {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

function reader(body) {
  let offset = 0
  const take = length => {
    if (length > body.length - offset) throw packetError()
    const bytes = body.subarray(offset, offset + length)
    offset += length
    return bytes
  }
  const number = () => take(4).readUInt32BE(0)
  return {
    take, number,
    string: () => take(number()).toString('utf8'),
    count(minBytes) {
      const size = number()
      if (size > Math.floor((body.length - offset) / minBytes)) throw packetError()
      return size
    },
    end() { if (offset !== body.length) throw packetError() }
  }
}

async function connectJdwp({ host, port, timeoutMs = 5000, signal } = {}) {
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('디버그 연결은 로컬 JVM만 사용할 수 있습니다.')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff) throw new Error('JVM 응답 제한 시간이 올바르지 않습니다.')

  if (signal?.aborted) throw closedError()
  const socket = net.createConnection({ host, port })
  socket.setNoDelay(true)
  const pending = new Map()
  const listeners = new Set()
  let closed = null
  let sequence = 0
  let needed = 0
  let used = 0
  let frame = null
  let consume
  let handshakeTimer
  let rejectHandshake
  const abort = () => flushClose(closedError())

  function flushClose(error) {
    if (closed) return
    closed = error
    signal?.removeEventListener('abort', abort)
    clearTimeout(handshakeTimer)
    rejectHandshake?.(error)
    socket.destroy()
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
    for (const callback of listeners) {
      try { callback(error) } catch { /* An observer cannot interrupt connection cleanup. */ }
    }
    listeners.clear()
  }

  function expectBytes(length, action, copy = true) {
    needed = length
    used = 0
    frame = copy ? Buffer.allocUnsafe(length) : null
    consume = action
  }

  function nextPacket() {
    expectBytes(HEADER_BYTES, header => {
      const bytes = header.readUInt32BE(0)
      const id = header.readUInt32BE(4)
      const flags = header[8]
      if (bytes < HEADER_BYTES || bytes > MAX_PACKET_BYTES || (flags !== 0 && flags !== REPLY)) throw packetError()
      // Commands from the VM (including VMStart) are consumed without replying or allocating their payload.
      const request = flags === REPLY ? pending.get(id) : null
      const code = flags === REPLY ? header.readUInt16BE(9) : 0
      const finish = body => {
        nextPacket()
        if (!request) return
        pending.delete(id)
        clearTimeout(request.timer)
        if (code) request.reject(new JdwpError(code, request.signature))
        else request.resolve(body)
      }
      if (bytes === HEADER_BYTES) finish(EMPTY)
      else expectBytes(bytes - HEADER_BYTES, finish, Boolean(request))
    })
  }

  function request(command, parts = [], signature = null, requestTimeout = timeoutMs) {
    if (closed) return Promise.reject(closed)
    const length = parts.reduce((size, buffer) => size + buffer.length, HEADER_BYTES)
    if (length > MAX_PACKET_BYTES) return Promise.reject(new Error('JVM에 보낼 클래스 데이터가 너무 큽니다.'))
    do { sequence = sequence === 0xffffffff ? 1 : sequence + 1 } while (pending.has(sequence))
    const id = sequence
    const header = Buffer.alloc(HEADER_BYTES)
    header.writeUInt32BE(length, 0)
    header.writeUInt32BE(id, 4)
    header[9] = VM_COMMAND_SET
    header[10] = command
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => flushClose(new Error(command === 18
        ? 'JVM이 시간 안에 응답하지 않아 변경 반영 여부를 확인할 수 없습니다.'
        : 'JVM 응답 시간이 초과되었습니다.')), requestTimeout)
      timer.unref?.()
      pending.set(id, { resolve, reject, signature, timer })
      socket.write(parts.length ? Buffer.concat([header, ...parts], length) : header)
    })
  }

  const handshake = new Promise((resolve, reject) => {
    rejectHandshake = reject
    expectBytes(HANDSHAKE.length, bytes => {
      if (!HANDSHAKE.equals(bytes)) throw new Error('JVM 디버그 핸드셰이크가 올바르지 않습니다.')
      clearTimeout(handshakeTimer)
      rejectHandshake = null
      nextPacket()
      resolve()
    })
    handshakeTimer = setTimeout(() => flushClose(new Error('JVM 디버그 연결 시간이 초과되었습니다.')), timeoutMs)
    handshakeTimer.unref?.()
  })

  socket.once('connect', () => socket.write(HANDSHAKE))
  socket.on('data', chunk => {
    try {
      for (let from = 0; !closed && from < chunk.length;) {
        const length = Math.min(needed - used, chunk.length - from)
        if (frame) chunk.copy(frame, used, from, from + length)
        from += length
        used += length
        if (used === needed) consume(frame)
      }
    } catch (error) { flushClose(error) }
  })
  socket.on('error', () => flushClose(closedError()))
  socket.once('close', () => flushClose(used ? new Error('JVM 디버그 패킷이 중간에서 끊겼습니다.') : closedError()))
  signal?.addEventListener('abort', abort, { once: true })

  await handshake
  if (closed) throw closed
  let idSizes

  function getReferenceTypeSize() {
    // Reconnecting while the app is locked may complete the handshake only.
    idSizes ??= request(7).then(body => {
      const sizes = reader(body)
      const ids = Array.from({ length: 5 }, sizes.number)
      sizes.end()
      if (ids.some(size => size < 1 || size > 8)) throw packetError()
      return ids[3]
    }).catch(error => {
      flushClose(error)
      throw error
    })
    return idSizes
  }

  async function classesBySignature(signature, referenceTypeSize, signal) {
    const encoded = Buffer.from(signature, 'utf8')
    signal?.throwIfAborted()
    const body = await request(2, [int(encoded.length), encoded], signature)
    signal?.throwIfAborted()
    const result = reader(body)
    const count = result.count(1 + referenceTypeSize + 4)
    const classes = []
    for (let index = 0; index < count; index++) {
      result.take(1) // reference type tag
      classes.push(result.take(referenceTypeSize))
      result.take(4) // JVM class status
    }
    result.end()
    return classes
  }

  return {
    async canRedefine() {
      const body = await request(17)
      if (body.length < 8 || body[7] > 1) throw packetError()
      return body[7] === 1
    },
    async classPaths() {
      // The peer supplies these paths. Validate them against the worktree before using them.
      const result = reader(await request(13))
      const baseDir = result.string()
      const classpaths = Array.from({ length: result.count(4) }, result.string)
      const bootclasspaths = Array.from({ length: result.count(4) }, result.string)
      result.end()
      return { baseDir, classpaths, bootclasspaths }
    },
    async redefine(classes, { signal } = {}) {
      signal?.throwIfAborted()
      if (!Array.isArray(classes)) throw new Error('다시 적재할 클래스를 확인해 주세요.')
      const seen = new Set()
      for (const entry of classes) {
        if (typeof entry?.signature !== 'string' || !/^L[^;[.\0]+;$/u.test(entry.signature) || Buffer.byteLength(entry.signature) > 65535
          || !Buffer.isBuffer(entry.bytes) || !entry.bytes.length || entry.bytes.length > MAX_PACKET_BYTES || seen.has(entry.signature)) {
          throw new Error('다시 적재할 클래스의 이름이나 데이터가 올바르지 않습니다.')
        }
        seen.add(entry.signature)
      }
      if (!classes.length) return { redefined: 0, notLoaded: [] }

      const referenceTypeSize = await getReferenceTypeSize()
      signal?.throwIfAborted()
      const notLoaded = []
      const parts = []
      const loadedSignatures = new Set()
      let length = HEADER_BYTES + 4
      for (const { signature, bytes } of classes) {
        const ids = await classesBySignature(signature, referenceTypeSize, signal)
        if (!ids.length) notLoaded.push(signature)
        for (const id of ids) {
          length += referenceTypeSize + 4 + bytes.length
          if (length > MAX_PACKET_BYTES) throw new Error('JVM에 보낼 클래스 데이터가 너무 큽니다.')
          parts.push(id, int(bytes.length), bytes)
          loadedSignatures.add(signature)
        }
      }
      const redefined = parts.length / 3
      if (redefined) {
        // One VM request so a schema error cannot leave half a change applied. The VM gives one error code for the batch.
        const signature = loadedSignatures.size === 1 ? loadedSignatures.values().next().value : null
        signal?.throwIfAborted()
        const result = await request(18, [int(redefined), ...parts], signature, Math.max(timeoutMs, REDEFINE_TIMEOUT_MS))
        signal?.throwIfAborted()
        if (result.length) throw packetError()
      }
      return { redefined, notLoaded }
    },
    close: () => flushClose(closedError()),
    onClose(callback) {
      if (closed) callback(closed)
      else listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
}

module.exports = { connectJdwp, JdwpError }
