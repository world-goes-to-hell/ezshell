// Extracts a zip archive into a folder: the files stream out one after another (the Oracle client
// has a 200 MB library), and no entry may land outside the folder. Only what such an archive needs:
// stored and deflated entries, no encryption, no Zip64.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { pipeline } = require('stream/promises')

const END_SIGNATURE = 0x06054b50
const ENTRY_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_ENTRIES = 5000
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
/** The end record is the last 22 bytes, or sits before a comment of at most 64 KB */
const MAX_END_SEARCH = 22 + 0xffff

/**
 * Where an entry goes inside `targetDir`, or null when its name would leave it (an absolute path,
 * a drive letter, "..") or cannot be a file name here.
 */
function safeTarget(targetDir, name) {
  const normal = String(name).replace(/\\/g, '/')
  if (!normal || normal.startsWith('/') || /^[A-Za-z]:/.test(normal) || normal.includes('\0')) return null
  const parts = normal.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.length === 0 || parts.some((part) => part === '..' || /[<>:"|?*]/.test(part))) return null
  const target = path.resolve(targetDir, ...parts)
  const root = path.resolve(targetDir)
  return target === root || target.startsWith(root + path.sep) ? target : null
}

async function readAt(file, position, length) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await file.read(buffer, 0, length, position)
  if (bytesRead !== length) throw new Error('The archive is cut short')
  return buffer
}

/** The entries of the archive's directory: { name, method, compressedSize, size, offset, isDirectory } */
async function readEntries(file, fileSize) {
  const searchLength = Math.min(fileSize, MAX_END_SEARCH)
  const tail = await readAt(file, fileSize - searchLength, searchLength)
  let end = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === END_SIGNATURE) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('Not a zip archive')
  const count = tail.readUInt16LE(end + 10)
  const directorySize = tail.readUInt32LE(end + 12)
  const directoryOffset = tail.readUInt32LE(end + 16)
  if (count > MAX_ENTRIES || count === 0xffff || directoryOffset === 0xffffffff) throw new Error('The archive is too large for this reader')
  const directory = await readAt(file, directoryOffset, directorySize)
  const entries = []
  let at = 0
  for (let i = 0; i < count; i++) {
    if (directory.readUInt32LE(at) !== ENTRY_SIGNATURE) throw new Error('The archive directory is damaged')
    const flags = directory.readUInt16LE(at + 8)
    const method = directory.readUInt16LE(at + 10)
    const compressedSize = directory.readUInt32LE(at + 20)
    const size = directory.readUInt32LE(at + 24)
    const nameLength = directory.readUInt16LE(at + 28)
    const extraLength = directory.readUInt16LE(at + 30)
    const commentLength = directory.readUInt16LE(at + 32)
    const offset = directory.readUInt32LE(at + 42)
    const name = directory.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    if (flags & 0x1) throw new Error('Encrypted archives are not supported')
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new Error('The archive is too large for this reader')
    entries.push({ name, method, compressedSize, size, offset, isDirectory: name.endsWith('/') })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Extracts `zipPath` into `targetDir` (created if needed). Rejects, having written nothing outside
 * `targetDir`, when an entry's name would leave the folder or the archive is not one this reads.
 * Resolves with the number of files written.
 */
async function extractZip(zipPath, targetDir) {
  const file = await fs.promises.open(zipPath, 'r')
  try {
    const { size: fileSize } = await file.stat()
    const entries = await readEntries(file, fileSize)
    // Everything is checked before anything is written
    let total = 0
    const planned = entries.map((entry) => {
      const target = safeTarget(targetDir, entry.name)
      if (!target) throw new Error(`The archive holds a path that leaves the folder: ${entry.name.slice(0, 80)}`)
      if (!entry.isDirectory && entry.method !== 0 && entry.method !== 8) throw new Error('The archive uses a compression this reader does not know')
      total += entry.size
      return { ...entry, target }
    })
    if (total > MAX_TOTAL_BYTES) throw new Error('The archive would unpack to too much')

    let written = 0
    for (const entry of planned) {
      if (entry.isDirectory) {
        await fs.promises.mkdir(entry.target, { recursive: true })
        continue
      }
      await fs.promises.mkdir(path.dirname(entry.target), { recursive: true })
      const local = await readAt(file, entry.offset, 30)
      if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error('The archive is damaged')
      const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
      const output = fs.createWriteStream(entry.target)
      if (entry.compressedSize === 0) {
        await new Promise((resolve, reject) => output.end((err) => (err ? reject(err) : resolve())))
      } else {
        const input = fs.createReadStream(zipPath, { start, end: start + entry.compressedSize - 1 })
        if (entry.method === 8) await pipeline(input, zlib.createInflateRaw(), output)
        else await pipeline(input, output)
      }
      const { size } = await fs.promises.stat(entry.target)
      if (size !== entry.size) throw new Error(`A file came out with the wrong size: ${entry.name.slice(0, 80)}`)
      written += 1
    }
    return written
  } finally {
    await file.close()
  }
}

module.exports = { extractZip, safeTarget }
