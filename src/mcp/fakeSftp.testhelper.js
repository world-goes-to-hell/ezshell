// In-memory stand-in for ssh2's SFTP wrapper, for tests only (not copied into the build).
// `tree` maps absolute paths to nodes:
//   { type: 'file', data: string | Buffer, mode?, endless? } | { type: 'dir' } | { type: 'link', target } | { type: 'special' }
// `endless` files report size 0 and never reach the end when read (like some files under /proc).
// Options:
//   failRead        paths that cannot be opened for reading
//   failWriteCalls  fail the n-th write() calls (1-based); likewise failFsetstatCalls, failCloseCalls
//   onBeforeOpen(path, flags)  hook, e.g. to change the tree at the last moment
const path = require('path').posix

const NO_SUCH_FILE = 2
const PERMISSION_DENIED = 3
const FAILURE = 4
const MAX_LINK_DEPTH = 8

const failure = (code, message) => Object.assign(new Error(message), { code })

function createFakeSftp(initialTree = {}, { failRead = [], failWriteCalls = [], failFsetstatCalls = [], failCloseCalls = [], onBeforeOpen } = {}) {
  const tree = new Map([['/', { type: 'dir' }], ...Object.entries(initialTree)])
  const calls = []
  const handles = new Map()
  const counts = { write: 0, fsetstat: 0, close: 0 }
  let nextHandle = 1
  let ended = false

  /** Follow links in every component; the last one only when `followLast`. */
  function locate(target, followLast, depth = 0) {
    if (depth > MAX_LINK_DEPTH) throw failure(FAILURE, 'Too many links')
    const parts = path.normalize(target).split('/').filter(Boolean)
    let current = '/'
    for (let i = 0; i < parts.length; i++) {
      const next = path.join(current, parts[i])
      const node = tree.get(next)
      const isLast = i === parts.length - 1
      if (!node) {
        if (isLast) return { path: next, node: null }
        throw failure(NO_SUCH_FILE, 'No such file')
      }
      if (node.type === 'link' && (!isLast || followLast)) {
        return locate(path.join(node.target, ...parts.slice(i + 1)), followLast, depth + 1)
      }
      if (!isLast && node.type !== 'dir') throw failure(FAILURE, 'Not a directory')
      current = next
    }
    return { path: current, node: tree.get(current) }
  }

  const sizeOf = (node) => (node.type === 'file' && !node.endless ? Buffer.byteLength(node.data) : 0)
  const statsOf = (node) => ({
    size: sizeOf(node),
    mode: node.mode ?? 0o100644,
    isFile: () => node.type === 'file',
    isDirectory: () => node.type === 'dir',
    isSymbolicLink: () => node.type === 'link'
  })

  /** Run `work` and hand its result to the node-style callback on a later tick. */
  const reply = (cb, work) => {
    let outcome
    try {
      outcome = [null, work()]
    } catch (err) {
      outcome = [err]
    }
    setImmediate(() => cb(...outcome))
  }
  const existing = (found) => {
    if (!found.node) throw failure(NO_SUCH_FILE, 'No such file')
    return found
  }
  const targetOf = (handle) => handles.get(handle.toString())
  const nodeOf = (handle) => {
    const node = tree.get(targetOf(handle))
    if (!node) throw failure(FAILURE, 'Bad handle')
    return node
  }
  const failsNow = (name, list) => {
    counts[name]++
    return list.includes(counts[name])
  }

  return {
    tree,
    calls,
    /** Text of a file in the tree, or null */
    text: (target) => { const node = tree.get(target); return node && node.type === 'file' ? Buffer.from(node.data).toString('utf8') : null },
    openHandles: () => handles.size,
    isEnded: () => ended,
    end: () => { ended = true },

    realpath(target, cb) {
      calls.push(['realpath', target])
      reply(cb, () => existing(locate(target, true)).path)
    },
    lstat(target, cb) {
      calls.push(['lstat', target])
      reply(cb, () => statsOf(existing(locate(target, false)).node))
    },
    stat(target, cb) {
      calls.push(['stat', target])
      reply(cb, () => statsOf(existing(locate(target, true)).node))
    },
    open(target, flags, attrs, cb) {
      calls.push(['open', target, flags, attrs])
      if (onBeforeOpen) onBeforeOpen(target, flags)
      reply(cb, () => {
        const found = locate(target, true)
        const isRead = flags === 'r' || flags === 'r+'
        if (isRead) {
          existing(found)
          if (failRead.includes(found.path)) throw failure(PERMISSION_DENIED, 'Permission denied')
        } else {
          if (flags === 'wx' && found.node) throw failure(FAILURE, 'File exists')
          if (!tree.get(path.dirname(found.path))) throw failure(NO_SUCH_FILE, 'No such file')
          if (found.node && found.node.type !== 'file') throw failure(FAILURE, 'Not a file')
          // 'w' and 'wx' start from an empty file
          tree.set(found.path, { type: 'file', data: Buffer.alloc(0), mode: found.node ? found.node.mode : (0o100000 | ((attrs && attrs.mode) || 0o644)) })
        }
        const handle = Buffer.from(String(nextHandle++))
        handles.set(handle.toString(), found.path)
        return handle
      })
    },
    fstat(handle, cb) {
      calls.push(['fstat', targetOf(handle)])
      reply(cb, () => statsOf(nodeOf(handle)))
    },
    read(handle, buffer, offset, length, position, cb) {
      calls.push(['read', targetOf(handle), position])
      reply(cb, () => {
        const node = nodeOf(handle)
        if (node.type !== 'file') throw failure(FAILURE, 'Not a file')
        if (node.endless) { buffer.fill(0x61, offset, offset + length); return length }
        const data = Buffer.from(node.data)
        if (position >= data.length) return 0
        return data.copy(buffer, offset, position, Math.min(data.length, position + length))
      })
    },
    write(handle, buffer, offset, length, position, cb) {
      const target = targetOf(handle)
      calls.push(['write', target, length])
      const fails = failsNow('write', failWriteCalls)
      reply(cb, () => {
        if (fails) throw failure(FAILURE, 'Write failed')
        const node = nodeOf(handle)
        const previous = Buffer.from(node.data)
        const next = Buffer.alloc(Math.max(previous.length, position + length))
        previous.copy(next)
        buffer.copy(next, position, offset, offset + length)
        tree.set(target, { ...node, data: next })
      })
    },
    fsetstat(handle, attrs, cb) {
      const target = targetOf(handle)
      calls.push(['fsetstat', target, attrs])
      const fails = failsNow('fsetstat', failFsetstatCalls)
      reply(cb, () => {
        if (fails) throw failure(FAILURE, 'Setstat failed')
        const node = nodeOf(handle)
        if (attrs && typeof attrs.size === 'number') {
          const resized = Buffer.alloc(attrs.size)
          Buffer.from(node.data).copy(resized, 0, 0, attrs.size)
          tree.set(target, { ...node, data: resized })
        }
      })
    },
    close(handle, cb) {
      calls.push(['close', targetOf(handle)])
      const fails = failsNow('close', failCloseCalls)
      reply(cb, () => {
        handles.delete(handle.toString())
        if (fails) throw failure(FAILURE, 'Close failed')
      })
    },
    unlink(target, cb) {
      calls.push(['unlink', target])
      reply(cb, () => { tree.delete(existing(locate(target, false)).path) })
    }
  }
}

module.exports = { createFakeSftp }
