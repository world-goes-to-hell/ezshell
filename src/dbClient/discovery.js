// Finds the databases a server runs: from its listening ports and the processes that hold them,
// and from the ports Docker publishes for its containers (a database in a container is mostly
// published on another port than its usual one). Runs one short command on an exec channel of the
// tab's connection, once per connection: it only reads lists (ss, ps, docker ps). It never connects
// to a database: an unfinished MySQL handshake counts towards max_connect_errors, which can block the host.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.

// sh -c: the login shell may be csh, where 2>/dev/null does not work
// -p: the process of each listening port (only one's own without root; that is enough or it is simply missing).
// docker ps is given three seconds: a daemon that hangs must not hold the answer up.
const DISCOVERY_COMMAND = 'sh -c \'(ss -ltnpH || netstat -ltnp) 2>/dev/null; echo ---ezshell---; ps -eo comm= 2>/dev/null; echo ---ezshell---; (command -v docker >/dev/null 2>&1 && timeout 3 docker ps --format "{{.Ports}}|{{.Image}}|{{.Names}}") 2>/dev/null\''
const SEPARATOR = '---ezshell---'
const DISCOVERY_TIMEOUT_MS = 10000
const MAX_OUTPUT_BYTES = 256 * 1024

const KNOWN_PORTS = {
  3306: 'mysql',
  3307: 'mysql',
  5432: 'postgres',
  5433: 'postgres',
  1521: 'oracle',
  1433: 'mssql'
}

const SUPPORTED_ENGINES = new Set(['mysql', 'postgres', 'mssql', 'oracle'])

/** The engine a process belongs to; null for anything else */
function engineOfProcess(name) {
  if (name === 'mysqld' || name === 'mariadbd') return 'mysql'
  if (name === 'postgres' || name === 'postmaster') return 'postgres'
  if (name === 'tnslsnr') return 'oracle'
  if (name === 'sqlservr') return 'mssql'
  return null
}

/** The process that holds a listening port: ss prints users:(("name",pid=1,fd=3)), netstat "123/name" last */
function listenerProcess(line) {
  const ss = /users:\(\("([^"]+)"/.exec(line)
  if (ss) return ss[1]
  const netstat = /\s\d+\/([^\s/]+)\s*$/.exec(line)
  return netstat ? netstat[1] : null
}

/**
 * The ports Docker publishes, from `docker ps` lines ("0.0.0.0:51521->1521/tcp, :::51521->1521/tcp|image|name").
 * A container port that is a database's usual one says which engine it is, whatever the host port.
 */
function dockerPorts(text) {
  const found = new Map()
  for (const line of text.split('\n')) {
    const [ports, image = '', name = ''] = line.trim().split('|')
    if (!ports) continue
    for (const mapping of ports.split(',')) {
      const match = /^\s*(\[[^\]]*\]|[0-9a-fA-F.:]*?):(\d{1,5})->(\d{1,5})\/tcp\s*$/.exec(mapping)
      if (!match) continue
      const engine = KNOWN_PORTS[Number(match[3])]
      const port = Number(match[2])
      if (!engine || port < 1 || port > 65535) continue
      const host = match[1].replace(/^\[|\]$/g, '')
      const entry = found.get(port) || { engine, hosts: [], image: image.toLowerCase(), container: name.slice(0, 80) }
      found.set(port, { ...entry, hosts: [...entry.hosts, host] })
    }
  }
  return found
}

const ENGINE_LABELS = { mysql: 'MySQL/MariaDB', postgres: 'PostgreSQL', oracle: 'Oracle', mssql: 'SQL Server' }

/** `host:port` of a listening line's local address; IPv6 may be `[::]:5432`, `:::5432` or `*:3306`. */
function localAddress(line) {
  const tokens = line.trim().split(/\s+/)
  for (const token of tokens) {
    const match = token.match(/^(\[[^\]]+\]|[^\s]*?):(\d{1,5})$/)
    if (!match) continue
    const port = Number(match[2])
    if (port < 1 || port > 65535) continue
    const host = match[1].replace(/^\[|\]$/g, '').replace(/%.*$/, '')
    return { host, port }
  }
  return null
}

const isWildcard = (host) => host === '' || host === '*' || host === '0.0.0.0' || host === '::' || host === '::0'
const isLoopback = (host) => host === '127.0.0.1' || host === '::1' || host.startsWith('127.')

/** The address a tunnel from the server reaches the port on. */
function reachableHost(hosts) {
  if (hosts.some((h) => isWildcard(h) || h === '127.0.0.1' || h.startsWith('127.'))) return '127.0.0.1'
  if (hosts.includes('::1')) return '::1'
  return hosts[0]
}

function engineLabel(engine, processes) {
  if (engine === 'mysql') {
    if (processes.has('mariadbd')) return 'MariaDB'
    if (processes.has('mysqld')) return processes.has('mariadb') ? 'MariaDB' : 'MySQL'
  }
  return ENGINE_LABELS[engine]
}

function dockerLabel(engine, image) {
  if (engine === 'mysql') return /mariadb/.test(image) ? 'MariaDB' : /mysql|percona/.test(image) ? 'MySQL' : ENGINE_LABELS.mysql
  return ENGINE_LABELS[engine]
}

function isEngineRunning(engine, processes) {
  if (engine === 'mysql') return processes.has('mysqld') || processes.has('mariadbd')
  if (engine === 'postgres') return processes.has('postgres') || processes.has('postmaster')
  if (engine === 'oracle') return processes.has('tnslsnr')
  if (engine === 'mssql') return processes.has('sqlservr')
  return false
}

/**
 * The databases in the command's output, sorted by port. Each is
 * `{ engine, label, host, port, isLocalOnly, isSupported, isConfirmed }`: `isConfirmed` when a matching
 * process runs (a port alone may be something else), `isLocalOnly` when it listens on loopback only.
 */
function parseDiscovery(output) {
  const text = typeof output === 'string' ? output : ''
  const [ports = '', psText = '', dockerText = ''] = text.split(SEPARATOR)
  const processes = new Set(psText.split('\n').map((name) => name.trim().split('/').pop()).filter(Boolean))

  // port -> { engine, hosts, isByProcess }: a usual port, or any port a database process listens on
  const listening = new Map()
  for (const line of ports.split('\n')) {
    if (!/LISTEN/i.test(line)) continue
    const address = localAddress(line)
    if (!address) continue
    const byProcess = engineOfProcess(listenerProcess(line))
    const engine = byProcess || KNOWN_PORTS[address.port]
    if (!engine) continue
    const entry = listening.get(address.port) || { engine, hosts: [], isByProcess: false }
    listening.set(address.port, { engine: byProcess || entry.engine, hosts: [...entry.hosts, address.host], isByProcess: entry.isByProcess || Boolean(byProcess) })
  }

  const found = new Map()
  for (const [port, { engine, hosts, isByProcess }] of listening) {
    found.set(port, {
      engine,
      label: engineLabel(engine, processes),
      host: reachableHost(hosts),
      port,
      isLocalOnly: hosts.every((h) => isLoopback(h)),
      isSupported: SUPPORTED_ENGINES.has(engine),
      isConfirmed: isByProcess || isEngineRunning(engine, processes)
    })
  }
  // What Docker publishes says more than the port alone (the listener there is docker-proxy)
  for (const [port, { engine, hosts, image, container }] of dockerPorts(dockerText)) {
    found.set(port, {
      engine,
      label: dockerLabel(engine, image),
      host: reachableHost(hosts),
      port,
      isLocalOnly: hosts.every((h) => isLoopback(h)),
      isSupported: SUPPORTED_ENGINES.has(engine),
      isConfirmed: true,
      ...(container ? { container } : {})
    })
  }
  return [...found.values()].sort((a, b) => a.port - b.port)
}

/** Runs the command on `conn` (ssh2 Client) and returns its stdout, at most 256KB, within 10 seconds. */
function runDiscoveryCommand(conn, { timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let output = ''
    let isDone = false
    let channel = null
    const finish = (err) => {
      if (isDone) return
      isDone = true
      clearTimeout(timer)
      if (channel) {
        try { channel.close() } catch { /* already closed */ }
      }
      if (err) reject(err)
      else resolve(output)
    }
    const timer = setTimeout(() => finish(new Error('discovery timed out')), timeoutMs)
    conn.exec(DISCOVERY_COMMAND, (err, stream) => {
      if (err) return finish(err)
      channel = stream
      if (isDone) return finish()
      stream.on('data', (chunk) => {
        if (output.length < MAX_OUTPUT_BYTES) output += chunk.toString('utf8').slice(0, MAX_OUTPUT_BYTES - output.length)
      })
      stream.stderr?.on('data', () => {})
      stream.on('close', () => finish())
      stream.on('error', (e) => finish(e))
    })
  })
}

/**
 * Remembers one discovery per connection object, so switching tabs does not run the command again,
 * and a reconnected tab (a new connection) is looked at again.
 */
function createDiscoveryCache({ run = runDiscoveryCommand } = {}) {
  const results = new WeakMap()
  return {
    discover(conn) {
      if (!results.has(conn)) {
        const pending = run(conn).then(parseDiscovery, () => [])
        results.set(conn, pending)
      }
      return results.get(conn)
    }
  }
}

module.exports = { DISCOVERY_COMMAND, parseDiscovery, runDiscoveryCommand, createDiscoveryCache, ENGINE_LABELS, SUPPORTED_ENGINES }
