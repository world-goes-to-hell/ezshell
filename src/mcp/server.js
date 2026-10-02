// Local MCP endpoint for Claude Code (Streamable HTTP, stateless: one MCP server per request).
// Listens on 127.0.0.1 only, needs the bearer token, and refuses anything from a browser page.
const http = require('http')
const crypto = require('crypto')
const { McpServer, StreamableHTTPServerTransport, z } = require('./sdk.js')
const { combineSignals } = require('./signals.js')

const MCP_PATH = '/mcp'
const BIND_HOST = '127.0.0.1'
const MAX_BODY_BYTES = 1024 * 1024
const MAX_COMMAND_LENGTH = 4000
const MAX_PATH_LENGTH = 1024
/** Characters; the handlers check the size in bytes (256KB) */
const MAX_FILE_CHARS = 256 * 1024

const DESCRIPTIONS = {
  listSessions: '이 SSH 클라이언트 앱에서 MCP 접근이 허용된 세션 목록(id, 이름, 폴더, 서버 표지, 현재 작업 디렉터리)을 돌려줍니다. 다른 도구의 session 인자에는 여기서 받은 id 를 넘기세요. server 값이 같은 세션은 같은 서버에 접속하므로 한 번만 조회하면 됩니다. 값이 달라도 같은 서버일 수 있습니다(주소를 다르게 등록한 경우). 번호는 이 목록 안에서만 의미가 있습니다.',
  cd: '세션의 작업 디렉터리를 바꿉니다. 이후 run_command 는 이 디렉터리에서 실행됩니다. run_command 안에서 실행한 cd 는 그 명령에만 적용됩니다.',
  writeFile: '세션 서버에 텍스트 파일을 새로 만들거나 파일 전체를 새 내용으로 바꿉니다. 셸을 거치지 않고 쓰므로 따옴표나 변수 치환 걱정이 없습니다. 사용자가 앱에서 변경 내용(diff)을 보고 허용해야 쓰이며, 최대 180초 기다립니다. 256KB 이하의 UTF-8 텍스트만 됩니다. 상위 폴더는 미리 있어야 하고, 접속 계정의 권한으로 씁니다(sudo 없음). 파일의 일부만 고칠 때는 edit_file 을 쓰세요.',
  editFile: '세션 서버의 텍스트 파일에서 old_string 을 new_string 으로 바꿉니다. old_string 은 파일에 정확히 한 번만 나와야 합니다(여러 곳을 모두 바꾸려면 replace_all). 먼저 run_command 로 파일 내용을 확인하고, 공백과 줄바꿈까지 그대로 지정하세요. 사용자가 앱에서 변경 내용(diff)을 보고 허용해야 쓰이며, 최대 180초 기다립니다.',
  runCommand: '세션 서버에서 셸 명령을 실행하고 종료 코드와 출력을 돌려줍니다. 30초 제한, 출력 64KB 제한이 있습니다. 서버 상태를 바꾸는 명령은 사용자가 앱에서 승인해야 실행되고, 시스템 종료·루트 삭제 같은 명령은 항상 차단됩니다. 가능하면 조회 명령을 쓰세요.'
}

const BODY_DRAIN_MS = 1000

const GENERIC_ERROR_RESULT = Object.freeze({
  content: Object.freeze([Object.freeze({ type: 'text', text: 'MCP 요청을 처리하지 못했습니다.' })]),
  isError: true
})

function bearerMatches(expected, header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice('Bearer '.length))
  const wanted = Buffer.from(expected)
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted)
}

function sendError(res, status, message, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('Request too large'), { status: 413 })
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
      reject(tooLarge())
      return
    }
    const chunks = []
    let size = 0
    let rejected = false
    req.on('data', (chunk) => {
      if (rejected) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejected = true
        chunks.length = 0
        reject(tooLarge())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (rejected) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/** Handlers should not throw, but if one does the client must not see its message (it may hold host details). */
async function safely(call) {
  try {
    return await call()
  } catch (err) {
    console.error('[mcp] tool handler failed:', err)
    return GENERIC_ERROR_RESULT
  }
}

function buildMcpServer(handlers, { version, signal }) {
  const server = new McpServer({ name: 'my-ssh-client', version })
  const sessionArg = z.string().min(1).describe('list_sessions 에서 받은 세션 id')
  const signalFor = (extra) => combineSignals([signal, extra && extra.signal])
  server.registerTool('list_sessions', { description: DESCRIPTIONS.listSessions }, async () => safely(() => handlers.listSessions()))
  server.registerTool('cd', {
    description: DESCRIPTIONS.cd,
    inputSchema: { session: sessionArg, path: z.string().min(1).max(MAX_PATH_LENGTH).describe('이동할 경로 (절대 경로 또는 현재 위치 기준 상대 경로)') }
  }, async (args, extra) => safely(() => handlers.changeDirectory(args, { signal: signalFor(extra) })))
  server.registerTool('run_command', {
    description: DESCRIPTIONS.runCommand,
    inputSchema: { session: sessionArg, command: z.string().min(1).max(MAX_COMMAND_LENGTH).describe('실행할 셸 명령') }
  }, async (args, extra) => safely(() => handlers.runCommand(args, { signal: signalFor(extra) })))
  const filePath = z.string().min(1).max(MAX_PATH_LENGTH).describe('파일 경로 (절대 경로, ~/로 시작하는 경로, 또는 현재 작업 디렉터리 기준 상대 경로)')
  server.registerTool('write_file', {
    description: DESCRIPTIONS.writeFile,
    inputSchema: { session: sessionArg, path: filePath, content: z.string().max(MAX_FILE_CHARS).describe('파일에 쓸 전체 내용') }
  }, async (args, extra) => safely(() => handlers.writeFile(args, { signal: signalFor(extra) })))
  server.registerTool('edit_file', {
    description: DESCRIPTIONS.editFile,
    inputSchema: {
      session: sessionArg,
      path: filePath,
      old_string: z.string().min(1).max(MAX_FILE_CHARS).describe('바꿀 문자열 (파일에 있는 그대로)'),
      new_string: z.string().max(MAX_FILE_CHARS).describe('새 문자열 (지우려면 빈 문자열)'),
      replace_all: z.boolean().optional().describe('old_string 이 나오는 모든 곳을 바꿉니다 (기본: 한 곳만, 여러 번 나오면 오류)')
    }
  }, async (args, extra) => safely(() => handlers.editFile(args, { signal: signalFor(extra) })))
  return server
}

function createMcpHttpServer({ getConfig, handlers, version }) {
  let httpServer = null
  let listeningPort = null
  let pendingStart = null

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost')
    if (pathname !== MCP_PATH) return sendError(res, 404, 'Not found')
    const host = req.headers.host
    if (host !== `127.0.0.1:${listeningPort}` && host !== `localhost:${listeningPort}`) return sendError(res, 403, 'Forbidden host')
    if (req.headers.origin !== undefined) return sendError(res, 403, 'Browser requests are not allowed')
    if (!bearerMatches(getConfig().token, req.headers.authorization)) return sendError(res, 401, 'Unauthorized')
    if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed')

    let body
    try {
      body = await readJsonBody(req)
    } catch (err) {
      if (err.status === 413) {
        // Answer first and keep discarding the upload so the client can read the reply; cut it off if it never finishes.
        res.once('finish', () => setTimeout(() => { if (!req.readableEnded) req.destroy() }, BODY_DRAIN_MS).unref())
        req.resume()
        return sendError(res, 413, err.message)
      }
      return sendError(res, err.status || 400, err.message)
    }

    const abort = new AbortController()
    const server = buildMcpServer(handlers, { version, signal: abort.signal })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      if (!res.writableFinished) abort.abort()
      transport.close().catch(() => {})
      server.close().catch(() => {})
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  function listen(port) {
    return new Promise((resolve, reject) => {
      const created = http.createServer((req, res) => {
        handle(req, res).catch((err) => {
          console.error('[mcp] request failed:', err)
          if (res.headersSent) res.destroy()
          else sendError(res, 500, 'Internal error')
        })
      })
      created.once('error', reject)
      created.listen(port, BIND_HOST, () => {
        created.removeListener('error', reject)
        created.on('error', () => { /* per-connection errors are not fatal */ })
        httpServer = created
        listeningPort = created.address().port
        resolve()
      })
    })
  }

  function start() {
    if (httpServer) return Promise.resolve()
    if (pendingStart) return pendingStart
    const { port } = getConfig()
    pendingStart = listen(port).finally(() => { pendingStart = null })
    return pendingStart
  }

  async function stop() {
    if (pendingStart) await pendingStart.catch(() => {})
    if (!httpServer) return
    const closing = httpServer
    httpServer = null
    listeningPort = null
    await new Promise((resolve) => {
      closing.close(() => resolve())
      closing.closeAllConnections()
    })
  }

  return { start, stop, isRunning: () => httpServer !== null, port: () => listeningPort }
}

module.exports = { createMcpHttpServer, MCP_PATH }
