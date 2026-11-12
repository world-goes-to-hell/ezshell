// Backup copies people leave next to a server file by hand ("compose.yaml.bak_20261020_1516",
// "index.jsp.261102", "index_bak.jsp"), so the file window can list them beside the app's own backups.
// Only names are looked at; nothing is read here. Loaded by main.js at runtime (copied to
// out/main/src), so keep it CommonJS without Electron.
const path = require('path').posix

const MAX_SERVER_BACKUPS = 50
// A backup's name is the file's name plus a mark: after it ("index.jsp.261102", "index.jsp_bak"), before
// the extension ("index_261102.jsp", "index (1).jsp") or in front ("bak_index.jsp", "Copy of index.jsp").
// The mark is a word that says "backup", a date, or a number.
const SEPARATORS = new Set(['.', '_', '-', '~', ' ', '(', '[', '#', ','])
const WORDS = ['backup', 'bak', 'bkp', 'bk', 'back', 'original', 'orig', 'org', 'ori', 'old', 'saved', 'save', 'sav', 'previous', 'prev', 'copy',
  '백업', '복사본', '사본', '원본', '이전', '구버전', '수정전', '변경전', '작업전', '적용전', '배포전', '반영전']
// "bak", "bak2", "old1"
const WORD_TOKEN = new RegExp(`^(?:${WORDS.join('|')})\\d{0,3}$`)
// A word anywhere in what follows the name: "bak_kim", "20261020.bak.gz"
const WORD_INSIDE = new RegExp(`(^|[^a-z가-힣])(?:${WORDS.join('|')})\\d{0,3}([^a-z가-힣]|$)`)
// Words that only join the others: "Copy of index.jsp", "index_v2_bak.jsp"
const FILLER_TOKEN = /^(?:of|v\d{1,3}|ver\d{0,3})$/
const TOKEN_BREAK = /[\s._\-~()[\]{}#,+]+/
const TIME = '(?:[-_.T ]?(\\d{2})[-_.:]?(\\d{2})(?:[-_.:]?(\\d{2}))?)?'
// 20261020, 2026-10-20, 2026_10_20; optionally followed by a time 1516, 151630, 15-16-30
const DATE_LONG = new RegExp(`(?<!\\d)(20\\d{2})[-_.]?(\\d{2})[-_.]?(\\d{2})${TIME}`)
// 261102, 26-11-02 (year, month, day), with the same optional time
const DATE_SHORT = new RegExp(`(?<!\\d)(\\d{2})[-_.]?(\\d{2})[-_.]?(\\d{2})${TIME}(?!\\d)`)

const call = (sftp, method, ...args) => new Promise((resolve, reject) => {
  sftp[method](...args, (err, value) => (err ? reject(err) : resolve(value)))
})

/** A two-digit year: this century unless that is later than next year, then the last one from 70 on */
function fullYear(twoDigits, now = new Date()) {
  if (2000 + twoDigits <= now.getFullYear() + 1) return 2000 + twoDigits
  return twoDigits >= 70 ? 1900 + twoDigits : null
}

/** The date a pattern found, as { time, text }, or null when it is not a real date */
function dateFrom(match, year) {
  if (!match || year === null) return null
  const [month, day] = [Number(match[2]), Number(match[3])]
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  const [hour, minute, second] = [match[4], match[5], match[6] ?? '0'].map(Number)
  const hasTime = match[4] !== undefined && hour < 24 && minute < 60 && second < 60
  return { time: hasTime ? new Date(year, month - 1, day, hour, minute, second).getTime() : date.getTime(), text: match[0] }
}

function findDate(mark) {
  const long = DATE_LONG.exec(mark)
  if (long) return dateFrom(long, Number(long[1]))
  const short = DATE_SHORT.exec(mark)
  return short ? dateFrom(short, fullYear(Number(short[1]))) : null
}

/** Local time from a date (and time) in the name, or null when there is none or it is not a real date. */
function stampOf(mark) {
  const found = findDate(mark)
  return found ? found.time : null
}

const isMonthDay = (digits) => {
  const [month, day] = [Number(digits.slice(0, 2)), Number(digits.slice(2))]
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

/**
 * What a mark is made of. `isOnlyMarks`: every part is a backup word, a date, a short number or a
 * joining word, so nothing in it names another file ("_admin", ".template").
 */
function readMark(mark) {
  const lower = mark.toLowerCase()
  const date = findDate(lower)
  const rest = date ? lower.replace(date.text, ' ') : lower
  const tokens = rest.split(TOKEN_BREAK).filter(Boolean)
  let hasWord = false
  let hasMonthDay = false
  let isOnlyMarks = true
  for (const token of tokens) {
    if (WORD_TOKEN.test(token)) hasWord = true
    else if (FILLER_TOKEN.test(token) || /^\d{1,2}$/.test(token)) continue
    else if (/^\d{4}$/.test(token) && isMonthDay(token)) hasMonthDay = true
    else isOnlyMarks = false
  }
  return {
    hasWord,
    hasDate: date !== null,
    hasMonthDay,
    isOnlyMarks,
    isOnlyDigits: tokens.length > 0 && tokens.every(token => /^\d+$/.test(token)),
    // "(1)", " (2)": what a file manager adds to a copy
    isCopyNumber: /^\s*\(\d{1,3}\)$/.test(mark)
  }
}

/** Whether `fileName` looks like a backup of `baseName` (same folder assumed). */
function matchServerBackup(fileName, baseName) {
  if (!baseName || fileName === baseName) return false

  // After the name: index.jsp.bak, index.jsp_261102, index.jsp.1, index.jsp~
  if (fileName.startsWith(baseName)) {
    const mark = fileName.slice(baseName.length)
    if (mark === '~') return true
    const read = readMark(mark)
    if (SEPARATORS.has(mark[0])) {
      if (WORD_INSIDE.test(mark.toLowerCase()) || read.hasDate || read.isOnlyDigits) return true
    } else if (read.isOnlyMarks && (read.hasWord || read.hasDate)) {
      // index.jspbak, index.jsp261102
      return true
    }
  }

  // Before the extension: index_261102.jsp, index.bak.jsp, index (1).jsp, index - 복사본.jsp
  const dot = baseName.lastIndexOf('.')
  if (dot > 0) {
    const [stem, extension] = [baseName.slice(0, dot), baseName.slice(dot)]
    if (fileName.length > baseName.length && fileName.startsWith(stem) && fileName.endsWith(extension)) {
      const read = readMark(fileName.slice(stem.length, fileName.length - extension.length))
      if (read.isOnlyMarks && (read.hasWord || read.hasDate || read.hasMonthDay || read.isCopyNumber)) return true
    }
  }

  // In front: bak_index.jsp, 261102_index.jsp, Copy of index.jsp, 복사본 - index.jsp
  if (fileName.length > baseName.length && fileName.endsWith(baseName)) {
    const mark = fileName.slice(0, fileName.length - baseName.length)
    const read = readMark(mark)
    // The mark ends where the name starts ("bak_", "Copy of "); a lone dot in front is a hidden file
    if (/[\s._\-)\]]$/.test(mark) && mark !== '.' && read.isOnlyMarks && (read.hasWord || read.hasDate || read.hasMonthDay)) return true
  }
  return false
}

/** The date in a backup's name, wherever its mark is */
function stampInName(fileName, baseName) {
  const at = fileName.indexOf(baseName)
  if (at >= 0) return stampOf(`${fileName.slice(0, at)} ${fileName.slice(at + baseName.length)}`)
  // Mark before the extension: the stem is not part of the mark
  const dot = baseName.lastIndexOf('.')
  return stampOf(dot > 0 && fileName.startsWith(baseName.slice(0, dot)) ? fileName.slice(dot) : fileName)
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
      const fromName = stampInName(entry.filename, base)
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

module.exports = { matchServerBackup, stampOf, stampInName, listServerBackups, MAX_SERVER_BACKUPS }
