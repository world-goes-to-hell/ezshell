import net from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { connectJdwp, JdwpError } from './jdwp.js'
import { readClassInfo } from './classFile.js'

const handshake = Buffer.from('JDWP-Handshake')
const ints = (...values) => {
  const buffer = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => buffer.writeUInt32BE(value, index * 4))
  return buffer
}
const string = (value) => Buffer.concat([ints(Buffer.byteLength(value)), Buffer.from(value)])
const header = (id, length, flags, code = 0) => {
  const bytes = Buffer.alloc(11)
  bytes.writeUInt32BE(length)
  bytes.writeUInt32BE(id, 4)
  bytes[8] = flags
  bytes.writeUInt16BE(code, 9)
  return bytes
}
const reply = (id, body = Buffer.alloc(0), code = 0) => Buffer.concat([header(id, 11 + body.length, 0x80, code), body])
const ref = hex => Buffer.concat([Buffer.from([1]), Buffer.from(hex, 'hex'), ints(7)])

let fixture
let vm
afterEach(async () => {
  vm?.close()
  vm = undefined
  await fixture?.close()
  fixture = undefined
})

async function peer(onCommand, { size = 8, opening = handshake, silent = false } = {}) {
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    let introduced = false
    let bytes = Buffer.alloc(0)
    socket.on('data', chunk => {
      if (silent) return
      bytes = Buffer.concat([bytes, chunk])
      if (!introduced && bytes.length >= handshake.length) {
        if (!bytes.subarray(0, handshake.length).equals(handshake)) return socket.destroy()
        introduced = true
        bytes = bytes.subarray(handshake.length)
        socket.write(opening.subarray(0, 3))
        setImmediate(() => {
          const body = Buffer.from([0, 0, 0, 2, 17])
          // One unsolicited VM command right after the fragmented handshake.
          socket.write(Buffer.concat([opening.subarray(3), header(444, 11 + body.length, 0, 0x4064), body]))
        })
      }
      while (introduced && bytes.length >= 11 && bytes.length >= bytes.readUInt32BE(0)) {
        const length = bytes.readUInt32BE(0)
        const id = bytes.readUInt32BE(4)
        const cmd = bytes[10]
        const body = bytes.subarray(11, length)
        bytes = bytes.subarray(length)
        if (cmd === 7) socket.write(reply(id, ints(8, 8, 8, size, 8)))
        else onCommand({ cmd, body, id, socket })
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  fixture = { port, close: () => {
    for (const socket of sockets) socket.destroy()
    return new Promise(resolve => server.close(resolve))
  } }
  return { host: '127.0.0.1', port }
}

describe('local JVM JDWP', () => {
  it('accepts only the literal IPv4 loopback address', async () => {
    for (const host of ['localhost', '::1', '0.0.0.0', '192.0.2.10']) {
      await expect(connectJdwp({ host, port: 12345 })).rejects.toThrow(/로컬 JVM/)
    }
  })

  it('matches out-of-order responses, discards VM events, and reads ClassPaths', async () => {
    let capabilities
    const address = await peer(({ cmd, id, socket }) => {
      if (cmd === 17) capabilities = id
      if (cmd === 13) {
        const body = Buffer.concat([string('C:/folder'), ints(2), string('one'), string('한글'), ints(1), string('boot')])
        const caps = Buffer.alloc(32)
        caps[7] = 1
        const message = Buffer.concat([reply(id, body), reply(capabilities, caps)])
        socket.write(message.subarray(0, 16))
        setImmediate(() => socket.write(message.subarray(16)))
      }
    })
    vm = await connectJdwp(address)
    const [capability, paths] = await Promise.all([vm.canRedefine(), vm.classPaths()])
    expect(capability).toBe(true)
    expect(paths).toEqual({ baseDir: 'C:/folder', classpaths: ['one', '한글'], bootclasspaths: ['boot'] })
  })

  it('loads every reference ID using the negotiated width and reports unloaded classes', async () => {
    const calls = []
    vm = await connectJdwp(await peer(({ cmd, body, id, socket }) => {
      calls.push(cmd)
      if (cmd === 2) {
        const signature = body.subarray(4).toString()
        const refs = signature === 'Lcom/x/Foo;' ? [ref('11112222'), ref('33334444')] : []
        socket.write(reply(id, Buffer.concat([ints(refs.length), ...refs])))
      }
      if (cmd === 18) {
        const bytes = Buffer.from('class')
        expect(body).toEqual(Buffer.concat([ints(2), Buffer.from('11112222', 'hex'), ints(5), bytes, Buffer.from('33334444', 'hex'), ints(5), bytes]))
        socket.write(reply(id))
      }
    }, { size: 4 }))
    expect(await vm.redefine([{ signature: 'Lcom/x/Foo;', bytes: Buffer.from('class') },
      { signature: 'Lcom/x/Unloaded;', bytes: Buffer.from('another') }])).toEqual({ redefined: 2, notLoaded: ['Lcom/x/Unloaded;'] })
    expect(calls).toEqual([2, 2, 18])
  })

  it('returns a Korean JDWP reason and the signature when the VM rejects one class', async () => {
    vm = await connectJdwp(await peer(({ cmd, id, socket }) => {
      if (cmd === 2) socket.write(reply(id, Buffer.concat([ints(1), ref('0000000100000002')])))
      if (cmd === 18) socket.write(reply(id, undefined, 63))
    }))
    await expect(vm.redefine([{ signature: 'LFoo;', bytes: Buffer.from('class') }])).rejects.toMatchObject({
      name: 'JdwpError', code: 63, reason: '메서드 추가', signature: 'LFoo;'
    })
    for (let code = 60; code <= 72; code++) expect(new JdwpError(code).reason).toMatch(/[가-힣]/)
  })

  it('rejects invalid handshakes and oversized packet headers', async () => {
    const bad = await peer(() => {}, { opening: Buffer.alloc(14, 0x61) })
    await expect(connectJdwp(bad)).rejects.toThrow(/핸드셰이크/)
    await fixture.close()
    vm = await connectJdwp(await peer(({ id, socket }) => socket.write(header(id, 64 * 1024 * 1024 + 1, 0x80))))
    await expect(vm.canRedefine()).rejects.toThrow(/응답 형식/)
  })

  it('detects truncated replies and reports the disconnection once', async () => {
    vm = await connectJdwp(await peer(({ id, socket }) => socket.end(Buffer.concat([header(id, 21, 0x80), Buffer.alloc(3)]))))
    const observed = []
    vm.onClose(error => observed.push(error.message))
    await expect(vm.classPaths()).rejects.toThrow(/중간에서 끊겼습니다/)
    vm.close()
    expect(observed).toEqual(['JVM 디버그 패킷이 중간에서 끊겼습니다.'])
  })

  it('bounds each request without exposing local addresses or paths', async () => {
    vm = await connectJdwp({ ...(await peer(() => {})), timeoutMs: 150 })
    await expect(vm.canRedefine()).rejects.toThrow(/^JVM 응답 시간이 초과되었습니다\.$/)
    await expect(vm.classPaths()).rejects.toThrow(/초과/)
  })

  it('allows a class redefinition to outlast the normal request deadline', async () => {
    const address = await peer(({ cmd, id, socket }) => {
      if (cmd === 2) socket.write(reply(id, Buffer.concat([ints(1), ref('0000000100000002')])))
      if (cmd === 18) setTimeout(() => socket.write(reply(id)), 350)
    })
    vm = await connectJdwp({ ...address, timeoutMs: 250 })
    await expect(vm.redefine([{ signature: 'LFoo;', bytes: Buffer.from('class') }]))
      .resolves.toEqual({ redefined: 1, notLoaded: [] })
  })

  it('aborts an unfinished handshake and an outstanding request', async () => {
    const initial = new AbortController()
    const address = await peer(() => {}, { silent: true })
    const connecting = connectJdwp({ ...address, signal: initial.signal })
    initial.abort()
    await expect(connecting).rejects.toThrow(/연결이 닫혔습니다/)
    await fixture.close()
    const active = new AbortController()
    vm = await connectJdwp({ ...(await peer(() => {})), signal: active.signal })
    const waiting = vm.classPaths()
    active.abort()
    await expect(waiting).rejects.toThrow(/연결이 닫혔습니다/)
  })
})

describe('class metadata', () => {
  function classFile(name = Buffer.from('com/x/Foo$Inner')) {
    const start = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61, 0, 5])
    const utf8 = Buffer.from([1, name.length >>> 8, name.length & 0xff])
    const long = Buffer.alloc(9)
    long[0] = 5
    return Buffer.concat([start, long, utf8, name, Buffer.from([7, 0, 3, 0, 1, 0, 4, 0, 0])])
  }

  it('reads class names and major versions across a two-slot constant', () => {
    expect(readClassInfo(classFile())).toEqual({ name: 'com/x/Foo$Inner', major: 61 })
    const name = Buffer.concat([Buffer.from('pkg/한'), Buffer.from([0xed, 0xa0, 0x81, 0xed, 0xb0, 0x80])])
    expect(readClassInfo(classFile(name))).toEqual({ name: 'pkg/한𐐀', major: 61 })
  })

  it('rejects truncated classes and malformed constant pool data', () => {
    const invalidTag = classFile()
    invalidTag[10] = 0xff
    for (const bytes of [Buffer.alloc(10), classFile().subarray(0, 22), invalidTag, classFile(Buffer.from('wrong.name'))]) {
      expect(() => readClassInfo(bytes)).toThrow(/클래스 파일 형식/)
    }
  })
})
