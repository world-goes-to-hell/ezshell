// Backup copies people leave next to a server file by hand ("compose.yaml.bak_20261020_1516"), so the
// file window can list them beside the app's own backups. Only names are looked at; nothing is read
// here. Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS without Electron.
const path = require('path').posix

const MAX_SERVER_BACKUPS = 50
// What may follow the file name: a separator, then something that says "backup" or a date
const SEPARATORS = new Set(['.', '_', '-', '~'])
const BACKUP_WORD = /(^|[^a-z])(bak|backup|orig|old|save|prev|copy)([^a-z]|$)/i
// 20261020, 2026-10-20, 2026_10_20; optionally followed by a time 1516, 151630, 15-16-30
const DATE = /(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[-_.T ]?(\d{2})[-_.:]?(\d{2})(?:[-_.:]?(\d{2}))?)?/

const call = (sftp, method, ...args) => new Promise((resolve, reject) => {
  sftp[method](...args, (err, value) => (err ? reject(err) : resolve(value)))
})

/** Local time from a date (and time) in the name, or null when there is none or it is not a real date. */
function stampOf(suffix) {
  const match = DATE.exec(suffix)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  const [hour, minute, second] = [match[4], match[5], match[6] ?? '0'].map(Number)
  const hasTime = match[4] !== undefined && hour < 24 && minute < 60 && second < 60
  return hasTime ? new Date(year, month - 1, day, hour, minute, second).getTime() : date.getTime()
}

/** Whether `fileName` looks like a backup of `baseName` (same folder assumed). */
function matchServerBackup(fileName, baseName) {
  if (!baseName || fileName === baseName || !fileName.startsWith(baseName)) return false
  const suffix = fileName.slice(baseName.length)
  if (!SEPARATORS.has(suffix[0])) return false
  if (suffix === '~') return true
  return BACKUP_WORD.test(suffix) || stampOf(suffix) !== null
}

/**
 * Backups beside the file, newest first, at most MAX_SERVER_BACKUPS. `realPath` is the file's real
 * path (its folder is listed); `requestedPath` is the name it was opened by, which may be a link with
 * backups of its own name. Only regular files: readdir reports entries themselves, so a link named like
 * a backup is left out instead of followed.
 */
async function listServerBackups(sftp, realPath, requestedPath = realPath) {
  const dir = path.dirname(realPath)
  const bases = [...new Set([path.basename(realPath), path.basename(requestedPath)])]
  const entries = await call(sftp, 'readdir', dir)
  const backups = entries
    .filter(entry => entry.attrs && entry.attrs.isFile() && bases.some(base => matchServerBackup(entry.filename, base)))
    .map(entry => {
      const base = bases.find(b => matchServerBackup(entry.filename, b))
      const fromName = stampOf(entry.filename.slice(base.length))
      return {
        name: entry.filename,
        path: path.join(dir, entry.filename),
        size: entry.attrs.size,
        // A server that sends no time sorts such files last instead of as NaN
        time: fromName ?? (Number.isFinite(entry.attrs.mtime) ? entry.attrs.mtime * 1000 : 0),
        timeFrom: fromName !== null ? 'name' : 'modified'
      }
    })
  return backups.sort((a, b) => b.time - a.time || a.name.localeCompare(b.name)).slice(0, MAX_SERVER_BACKUPS)
}

module.exports = { matchServerBackup, stampOf, listServerBackups, MAX_SERVER_BACKUPS }
