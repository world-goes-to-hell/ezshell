// What the container panel asks a server and how the answers are read. The commands are fixed
// here: the window never sends command text, only whether to include stopped containers and,
// for logs, a container name that passed isContainerName and was in the last list.

const MAX_CONTAINERS = 200
const FIELD_LIMIT = 300
/** Printed instead of a list when the server has no docker command */
const NO_DOCKER_MARK = '__EZSHELL_NO_DOCKER__'

/** docker's own rule for names; ids (hex) fit it too. The name goes into a command line. */
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const isContainerName = (value) => typeof value === 'string' && CONTAINER_NAME.test(value)

/**
 * `timeout`: a daemon that hangs must not hold the channel. Without docker the mark is printed and
 * the command still succeeds, so "no docker" is told apart from a failure.
 */
function listCommand({ all = false } = {}) {
  const ps = `timeout 5 docker ps${all ? ' -a' : ''} --format '{{json .}}'`
  return `sh -c "command -v docker >/dev/null 2>&1 || { echo ${NO_DOCKER_MARK}; exit 0; }; ${ps}"`
}

const text = (value) => (typeof value === 'string' ? value.slice(0, FIELD_LIMIT) : '')

/** One `docker ps --format '{{json .}}'` line; null for anything that is not a container row */
function readContainerLine(line) {
  let row
  try {
    row = JSON.parse(line)
  } catch {
    return null
  }
  if (!row || typeof row !== 'object') return null
  // `Names` can list several (legacy links): the first is the container's own name
  const name = text(row.Names).split(',')[0].trim()
  if (!isContainerName(name)) return null
  return {
    id: text(row.ID),
    name,
    image: text(row.Image),
    status: text(row.Status),
    state: text(row.State),
    ports: text(row.Ports)
  }
}

/**
 * @returns {{ kind: 'list', containers: object[], truncated: boolean }
 *   | { kind: 'no-docker' } | { kind: 'no-permission' } | { kind: 'error', message: string }}
 */
function readList({ stdout = '', stderr = '', exitCode = 0 }) {
  if (stdout.includes(NO_DOCKER_MARK)) return { kind: 'no-docker' }
  if (exitCode !== 0) {
    if (/permission denied/i.test(stderr)) return { kind: 'no-permission' }
    if (exitCode === 124) return { kind: 'error', message: '도커가 5초 안에 응답하지 않았습니다.' }
    // First line only, and nothing that looks like a path or address is added by the app
    const first = stderr.split('\n').map(line => line.trim()).find(Boolean) || ''
    return { kind: 'error', message: first.slice(0, 200) || '컨테이너 목록을 읽지 못했습니다.' }
  }
  const rows = stdout.split('\n').map(line => line.trim()).filter(Boolean).map(readContainerLine).filter(Boolean)
  return { kind: 'list', containers: rows.slice(0, MAX_CONTAINERS), truncated: rows.length > MAX_CONTAINERS }
}

module.exports = { listCommand, readList, readContainerLine, isContainerName, NO_DOCKER_MARK, MAX_CONTAINERS }
