import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'http'
import net from 'net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import serverModule from './server.js'

const { createMcpHttpServer } = serverModule
const TOKEN = 'ab'.repeat(32)

let server

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

afterEach(async () => {
  await server?.stop()
  server = undefined
})

const text = (value) => ({ content: [{ type: 'text', text: value }] })
const stubHandlers = (overrides = {}) => ({
  listSessions: () => text('[]'),
  changeDirectory: async () => text('cd ok'),
  runCommand: async (args) => text(`ran ${args.command}`),
  writeFile: async (args) => text(`wrote ${args.path}`),
  editFile: async (args) => text(`edited ${args.path}`),
  jobOutput: async (args) => text(`output of ${args.job}`),
  stopJob: async (args) => text(`stopped ${args.job}`),
  listJobs: () => text('[]'),
  ...overrides
})

async function startServer(handlers = stubHandlers()) {
  server = createMcpHttpServer({ getConfig: () => ({ port: 0, token: TOKEN }), handlers, version: 'test' })
  await server.start()
  return `http://127.0.0.1:${server.port()}/mcp`
}

async function connect(url) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }))
  return client
}

const postInit = (url, headers) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
})

describe('createMcpHttpServer', () => {
  it('lists the tools', async () => {
    const client = await connect(await startServer())
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name).sort()).toEqual(['cd', 'edit_file', 'job_output', 'list_jobs', 'list_sessions', 'run_command', 'stop_job', 'write_file'])
    await client.close()
  })

  it('hands the file tools their arguments and the request signal', async () => {
    const seen = []
    const record = (name) => async (args, options) => { seen.push([name, args, typeof options.signal?.aborted]); return text('ok') }
    const client = await connect(await startServer(stubHandlers({ writeFile: record('write'), editFile: record('edit') })))
    await client.callTool({ name: 'write_file', arguments: { session: 's1', path: '/tmp/a.txt', content: '' } })
    await client.callTool({ name: 'edit_file', arguments: { session: 's1', path: 'a.txt', old_string: 'a', new_string: '', replace_all: true } })
    expect(seen).toEqual([
      ['write', { session: 's1', path: '/tmp/a.txt', content: '' }, 'boolean'],
      ['edit', { session: 's1', path: 'a.txt', old_string: 'a', new_string: '', replace_all: true }, 'boolean']
    ])
    await client.close()
  })

  it('refuses file tool input the schema does not allow, before any handler runs', async () => {
    let called = 0
    const count = async () => { called++; return text('ok') }
    const client = await connect(await startServer(stubHandlers({ writeFile: count, editFile: count })))
    const bad = [
      { name: 'write_file', arguments: { session: 's1', path: '/tmp/a', content: 'a'.repeat(256 * 1024 + 1) } },
      { name: 'write_file', arguments: { session: 's1', path: '', content: 'x' } },
      { name: 'write_file', arguments: { session: 's1', path: '/tmp/a' } },
      { name: 'edit_file', arguments: { session: 's1', path: '/tmp/a', old_string: '', new_string: 'x' } },
      { name: 'edit_file', arguments: { session: 's1', path: '/tmp/a', old_string: 'a', new_string: 'b', replace_all: 'yes' } }
    ]
    for (const request of bad) {
      const outcome = await client.callTool(request).then(result => (result.isError ? 'error' : 'ok'), () => 'error')
      expect(outcome).toBe('error')
    }
    expect(called).toBe(0)
    await client.close()
  })

  it('hands the job tools their arguments', async () => {
    const seen = []
    const record = (name) => async (args) => { seen.push([name, args]); return text('ok') }
    const client = await connect(await startServer(stubHandlers({ runCommand: record('run'), jobOutput: record('output'), stopJob: record('stop') })))
    await client.callTool({ name: 'run_command', arguments: { session: 's1', command: 'make', background: true, timeout_minutes: 30 } })
    await client.callTool({ name: 'job_output', arguments: { job: 'job-1', wait_seconds: 5 } })
    await client.callTool({ name: 'stop_job', arguments: { job: 'job-1' } })
    expect((await client.callTool({ name: 'list_jobs', arguments: {} })).content[0].text).toBe('[]')
    expect(seen).toEqual([
      ['run', { session: 's1', command: 'make', background: true, timeout_minutes: 30 }],
      ['output', { job: 'job-1', wait_seconds: 5 }],
      ['stop', { job: 'job-1' }]
    ])
    await client.close()
  })

  it('refuses job tool input the schema does not allow, before any handler runs', async () => {
    let called = 0
    const count = async () => { called++; return text('ok') }
    const client = await connect(await startServer(stubHandlers({ runCommand: count, jobOutput: count, stopJob: count })))
    const bad = [
      { name: 'run_command', arguments: { session: 's1', command: 'make', background: 'yes' } },
      { name: 'run_command', arguments: { session: 's1', command: 'make', background: true, timeout_minutes: 61 } },
      { name: 'run_command', arguments: { session: 's1', command: 'make', background: true, timeout_minutes: 0 } },
      { name: 'run_command', arguments: { session: 's1', command: 'make', background: true, timeout_minutes: 1.5 } },
      { name: 'job_output', arguments: { job: 'job-1', wait_seconds: 26 } },
      { name: 'job_output', arguments: { job: '' } },
      { name: 'stop_job', arguments: { job: 'x'.repeat(65) } },
      { name: 'stop_job', arguments: {} }
    ]
    for (const request of bad) {
      const outcome = await client.callTool(request).then(result => (result.isError ? 'error' : 'ok'), () => 'error')
      expect(outcome).toBe('error')
    }
    expect(called).toBe(0)
    await client.close()
  })

  it('passes tool arguments to the handlers', async () => {
    const client = await connect(await startServer())
    const result = await client.callTool({ name: 'run_command', arguments: { session: 's1', command: 'ls -al' } })
    expect(result.content[0].text).toBe('ran ls -al')
    await client.close()
  })

  it('returns a generic error when a handler throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = () => { throw new Error('secret host 10.0.0.5') }
    const client = await connect(await startServer(stubHandlers({
      listSessions: boom,
      changeDirectory: async () => boom(),
      runCommand: async () => boom()
    })))
    const calls = [
      { name: 'list_sessions', arguments: {} },
      { name: 'cd', arguments: { session: 's1', path: '/tmp' } },
      { name: 'run_command', arguments: { session: 's1', command: 'ls' } }
    ]
    for (const call of calls) {
      const result = await client.callTool(call)
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe('MCP 요청을 처리하지 못했습니다.')
    }
    expect(errorSpy).toHaveBeenCalledTimes(3)
    expect(errorSpy.mock.calls[0][0]).toBe('[mcp] tool handler failed:')
    await client.close()
    errorSpy.mockRestore()
  })

  it('logs and answers 500 when request handling fails unexpectedly', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let calls = 0
    server = createMcpHttpServer({
      getConfig: () => { calls += 1; if (calls > 1) throw new Error('config broke'); return { port: 0, token: TOKEN } },
      handlers: stubHandlers(),
      version: 'test'
    })
    await server.start()
    const res = await postInit(`http://127.0.0.1:${server.port()}/mcp`, { Authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('config broke')
    expect(errorSpy).toHaveBeenCalledWith('[mcp] request failed:', expect.any(Error))
    errorSpy.mockRestore()
  })

  it('rejects a wrong token of the same length', async () => {
    const url = await startServer()
    const wrong = 'cd'.repeat(32)
    expect(wrong.length).toBe(TOKEN.length)
    expect((await postInit(url, { Authorization: `Bearer ${wrong}` })).status).toBe(401)
  })

  it('rejects Origin: null', async () => {
    const url = await startServer()
    expect((await postInit(url, { Authorization: `Bearer ${TOKEN}`, Origin: 'null' })).status).toBe(403)
  })

  it('answers 413 for an oversized body', async () => {
    const url = await startServer()
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) })
    })
    expect(res.status).toBe(413)
  })

  it('answers 413 for an oversized chunked body without Content-Length', async () => {
    await startServer()
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.port(), path: '/mcp', method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode) })
      req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve('reset') : reject(err)))
      req.write('"' + 'x'.repeat(2 * 1024 * 1024))
      req.end('"')
    })
    expect(status).toBe(413)
  })

  it('does not abort the handler signal after a normal call', async () => {
    let seenSignal
    const client = await connect(await startServer(stubHandlers({
      runCommand: async (args, { signal }) => { seenSignal = signal; return text('done') }
    })))
    await client.callTool({ name: 'run_command', arguments: { session: 's1', command: 'ls' } })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(seenSignal.aborted).toBe(false)
    await client.close()
  })

  it('aborts an in-flight handler when the server stops', async () => {
    let seenSignal
    const client = await connect(await startServer(stubHandlers({
      runCommand: (args, { signal }) => new Promise((resolve) => {
        seenSignal = signal
        signal.addEventListener('abort', () => resolve(text('aborted')))
      })
    })))
    const call = client.callTool({ name: 'run_command', arguments: { session: 's1', command: 'sleep' } }).catch(() => 'closed')
    await vi.waitFor(() => expect(seenSignal).toBeDefined())
    await server.stop()
    await vi.waitFor(() => expect(seenSignal.aborted).toBe(true))
    // the SDK client may keep retrying a dropped stream, so closing it is enough; the call result is irrelevant here
    await client.close().catch(() => {})
    await call
  })

  it('stop() during a pending start() leaves the server stopped', async () => {
    server = createMcpHttpServer({ getConfig: () => ({ port: 0, token: TOKEN }), handlers: stubHandlers(), version: 'test' })
    const starting = server.start()
    await server.stop()
    await starting.catch(() => {})
    expect(server.isRunning()).toBe(false)
    expect(server.port()).toBe(null)
  })

  it('stop() during a pending start() closes the port', async () => {
    const port = await freePort()
    server = createMcpHttpServer({ getConfig: () => ({ port, token: TOKEN }), handlers: stubHandlers(), version: 'test' })
    const starting = server.start()
    await server.stop()
    await starting.catch(() => {})
    await expect(postInit(`http://127.0.0.1:${port}/mcp`, { Authorization: `Bearer ${TOKEN}` })).rejects.toThrow()
  })

  it('concurrent start() calls share one server', async () => {
    server = createMcpHttpServer({ getConfig: () => ({ port: 0, token: TOKEN }), handlers: stubHandlers(), version: 'test' })
    await Promise.all([server.start(), server.start()])
    expect(server.isRunning()).toBe(true)
    const port = server.port()
    await server.stop()
    expect(server.isRunning()).toBe(false)
    await expect(postInit(`http://127.0.0.1:${port}/mcp`, { Authorization: `Bearer ${TOKEN}` })).rejects.toThrow()
  })

  it('concurrent start() on a fixed free port does not collide', async () => {
    const port = await freePort()
    server = createMcpHttpServer({ getConfig: () => ({ port, token: TOKEN }), handlers: stubHandlers(), version: 'test' })
    await expect(Promise.all([server.start(), server.start()])).resolves.toBeDefined()
    expect(server.port()).toBe(port)
  })

  it('rejects a wrong token', async () => {
    const url = await startServer()
    expect((await postInit(url, { Authorization: 'Bearer nope' })).status).toBe(401)
    expect((await postInit(url, {})).status).toBe(401)
  })

  it('rejects browser requests', async () => {
    const url = await startServer()
    expect((await postInit(url, { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' })).status).toBe(403)
  })

  it('rejects other Host headers', async () => {
    await startServer()
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.port(), path: '/mcp', method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${TOKEN}` } }, (res) => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject)
      req.end('{}')
    })
    expect(status).toBe(403)
  })

  it('answers 404 outside /mcp', async () => {
    const url = await startServer()
    expect((await fetch(url.replace('/mcp', '/other'), { method: 'POST' })).status).toBe(404)
  })

  it('reports a busy port', async () => {
    await startServer()
    const second = createMcpHttpServer({ getConfig: () => ({ port: server.port(), token: TOKEN }), handlers: stubHandlers(), version: 'test' })
    await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(second.isRunning()).toBe(false)
  })

  it('tells the handler when the client goes away', async () => {
    let seenSignal
    const url = await startServer(stubHandlers({
      runCommand: (args, { signal }) => new Promise((resolve) => {
        seenSignal = signal
        signal.addEventListener('abort', () => resolve(text('aborted')))
      })
    }))
    const client = await connect(url)
    const call = client.callTool({ name: 'run_command', arguments: { session: 's1', command: 'sleep' } }).catch(() => 'closed')
    await vi.waitFor(() => expect(seenSignal).toBeDefined())
    await client.close()
    await call
    await vi.waitFor(() => expect(seenSignal.aborted).toBe(true))
  })

  it('stops listening', async () => {
    const url = await startServer()
    await server.stop()
    expect(server.isRunning()).toBe(false)
    await expect(postInit(url, { Authorization: `Bearer ${TOKEN}` })).rejects.toThrow()
  })
})
