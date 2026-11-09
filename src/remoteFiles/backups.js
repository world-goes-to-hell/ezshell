// Copies of a server file taken right before the file window saves over it, kept on this PC:
// <root>\<session name> (<user>@<host>)\<folders of the server path>\<file name>.<YYYYMMDD-HHmmss>.bak
// Not on the server: folders such as /etc/cron.d or conf.d read every file in them, so a backup
// there could take effect, and the folder may not be writable.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const path = require('path')
const crypto = require('crypto')
const nodeFsp = require('fs/promises')
const { formatStamp } = require('../sessionLog/logFile.js')

const DEFAULT_KEEP = 20
const MAX_SEGMENT_LENGTH = 80
// Leave room under Windows' 260 characters for the file name that goes in the folder
const MAX_FOLDER_LENGTH = 200
const MAX_ATTEMPTS = 50
const UNSAFE_CHARS = /[\\/:*?"<>|\x00-\x1f\x7f]/g
// Windows refuses these as a name, also with trailing spaces or an extension ("CON .txt", "com¹")
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])\s*(\..*)?$/i
const MAX_SESSION_NAME_LENGTH = 40
const STAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/

/** One folder or file name on Windows, never "." or ".." and never a path separator. */
function safeSegment(name) {
  // Cut by code point: half of a surrogate pair would make a name readdir() gives back differently
  const replaced = Array.from(String(name ?? '').replace(UNSAFE_CHARS, '_')).slice(0, MAX_SEGMENT_LENGTH).join('')
  if (replaced.trim() === '' || /^\.+$/.test(replaced)) return '_'
  // Windows drops trailing dots and spaces, which would merge "a." with "a"
  const cleaned = replaced.replace(/[. ]+$/, (tail) => '_'.repeat(tail.length))
  return WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Where the backups of one server file go. `server` is { sessionName, username, host }; `remotePath`
 * is the real (absolute) path of the file.
 */
function backupTarget(root, server, remotePath) {
  // The session name is cut first, so "(user@host)" (from main, not the window) always stays in the name
  const sessionName = Array.from(String(server.sessionName || '세션')).slice(0, MAX_SESSION_NAME_LENGTH).join('')
  const serverFolder = safeSegment(`${sessionName} (${server.username || '?'}@${server.host || '?'})`)
  const parts = String(remotePath).split('/').filter(Boolean)
  const baseName = safeSegment(parts.pop() || 'file')
  const nested = path.join(root, serverFolder, ...parts.map(safeSegment))
  if (nested.length <= MAX_FOLDER_LENGTH) return { dir: nested, baseName }
  const digest = crypto.createHash('sha256').update(String(remotePath)).digest('hex').slice(0, 12)
  return { dir: path.join(root, serverFolder, `_긴 경로_${digest}`), baseName }
}

/** "nginx.conf.20261105-151200.bak" (or "-2" before ".bak" for a second one in the same second) → the time, or null */
function parseBackupName(baseName, name) {
  const match = new RegExp(`^${escapeRegExp(baseName)}\\.(\\d{8}-\\d{6})(?:-(\\d+))?\\.bak$`).exec(name)
  if (!match) return null
  const [, y, mo, d, h, mi, s] = STAMP.exec(match[1])
  return { createdAt: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime(), counter: Number(match[2] || 1) }
}

function createBackupStore({ root, fsp = nodeFsp, now = () => new Date(), keep = DEFAULT_KEEP }) {
  /** Backups of the file, newest first. */
  async function list(target) {
    let names
    try {
      names = await fsp.readdir(target.dir)
    } catch (err) {
      if (err && err.code === 'ENOENT') return []
      throw err
    }
    const found = names
      .map(name => ({ name, parsed: parseBackupName(target.baseName, name) }))
      .filter(entry => entry.parsed)
    const withSizes = await Promise.all(found.map(async ({ name, parsed }) => {
      const stats = await fsp.stat(path.join(target.dir, name)).catch(() => null)
      return stats && stats.isFile() ? { name, createdAt: parsed.createdAt, counter: parsed.counter, size: stats.size } : null
    }))
    return withSizes.filter(Boolean).sort((a, b) => (b.createdAt - a.createdAt) || (b.counter - a.counter))
  }

  /** Remove all but the newest `keep` (`justMade` among them). A failure leaves extra copies, never fewer. */
  async function prune(target, justMade = null) {
    const all = (await list(target)).filter(entry => entry.name !== justMade)
    const room = justMade ? keep - 1 : keep
    await Promise.all(all.slice(Math.max(room, 0)).map(entry => fsp.unlink(path.join(target.dir, entry.name)).catch(() => {})))
  }

  /**
   * Write `content` as a new backup and return its name. Throws when it could not be written: the
   * caller must not save then. Never replaces an existing backup.
   */
  async function save(target, content) {
    await fsp.mkdir(target.dir, { recursive: true })
    const stamp = formatStamp(now())
    // After the highest counter of this second: a name freed by pruning must not be taken again,
    // or the newest copy would sort as the oldest and be pruned at once
    const sameSecond = (await list(target)).filter(entry => entry.name.startsWith(`${target.baseName}.${stamp}`))
    const first = sameSecond.reduce((highest, entry) => Math.max(highest, entry.counter), 0) + 1
    for (let attempt = first; attempt < first + MAX_ATTEMPTS; attempt++) {
      const name = `${target.baseName}.${stamp}${attempt > 1 ? `-${attempt}` : ''}.bak`
      try {
        await fsp.writeFile(path.join(target.dir, name), content, { encoding: 'utf8', flag: 'wx' })
      } catch (err) {
        if (err && err.code === 'EEXIST') continue
        throw err
      }
      // Pruning is the caller's step, after the save it backs up went through: a refused save must not
      // cost an older copy
      return name
    }
    throw new Error('backup name taken')
  }

  /** The name must be one of this file's backups (no other file can be read through it). */
  const pathOf = (target, name) => {
    if (typeof name !== 'string' || !parseBackupName(target.baseName, name)) throw new Error('not a backup of this file')
    return path.join(target.dir, name)
  }

  const read = (target, name) => fsp.readFile(pathOf(target, name), 'utf8')
  const remove = (target, name) => fsp.unlink(pathOf(target, name))

  return { list, save, read, remove, prune }
}

module.exports = { createBackupStore, backupTarget, safeSegment, parseBackupName, DEFAULT_KEEP }
