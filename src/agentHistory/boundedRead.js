const fs = require('fs')
const zlib = require('zlib')

// Transcripts are large (hundreds of MB in total) and may hold secrets: read only a bounded part of
// each, never the whole file. Codex compresses older sessions (`.jsonl.zst`).
const isCompressed = file => file.endsWith('.zst')

function openStream(file, start, end) {
  const raw = fs.createReadStream(file, { highWaterMark: 64 * 1024, start, end })
  if (!isCompressed(file)) return { stream: raw, close: () => raw.destroy() }
  const inflate = zlib.createZstdDecompress()
  raw.on('error', error => inflate.destroy(error))
  raw.pipe(inflate)
  return { stream: inflate, close: () => { raw.destroy(); inflate.destroy() } }
}

/**
 * Calls `onLine(object)` for each JSON line from the start of the file until it returns true or
 * `maxBytes` (after decompression) have been read. `end` bounds the file read at an inclusive byte.
 * A line longer than `maxLine` is skipped. `start` starts an uncompressed file midstream and drops
 * the first partial line. `matchLine` can skip unrelated records before parsing their JSON.
 */
function readLinesFromStart(file, onLine, { maxBytes = 2 * 1024 * 1024, maxLine = 1024 * 1024, start, end, matchLine } = {}) {
  return new Promise((resolve, reject) => {
    const { stream, close } = openStream(file, start, end)
    let pending = []
    let pendingBytes = 0
    let skipping = start > 0
    let total = 0
    let done = false
    const finish = (error) => {
      if (done) return
      done = true
      close()
      if (error) reject(error)
      else resolve()
    }
    const emit = (buffer) => {
      if (!buffer.length) return false
      const line = buffer.toString('utf8')
      if (matchLine && !matchLine(line)) return false
      let value
      try { value = JSON.parse(line) } catch { return false }
      if (value === null || typeof value !== 'object') return false
      try { return onLine(value) === true } catch (error) { finish(error); return true }
    }
    stream.on('data', chunk => {
      if (done) return
      total += chunk.length
      let start = 0
      for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, start)) {
        const part = chunk.subarray(start, at)
        start = at + 1
        if (skipping) { skipping = false; pending = []; pendingBytes = 0; continue }
        const line = pending.length ? Buffer.concat([...pending, part]) : part
        pending = []
        pendingBytes = 0
        if (emit(line)) return finish()
      }
      if (start < chunk.length && !skipping) {
        pending.push(chunk.subarray(start))
        pendingBytes += chunk.length - start
        if (pendingBytes > maxLine) { skipping = true; pending = []; pendingBytes = 0 }
      }
      if (total >= maxBytes) finish()
    })
    stream.on('end', () => {
      if (!skipping && pending.length) emit(Buffer.concat(pending))
      finish()
    })
    stream.on('error', finish)
  })
}

/**
 * The JSON lines in the last `maxBytes` of the file (after decompression). The first, partial line
 * of the window is dropped. A compressed file is inflated as a stream, keeping only the window, and
 * gives up past `maxInflated` (returns null).
 */
async function readLinesFromEnd(file, { maxBytes = 256 * 1024, maxInflated = 128 * 1024 * 1024 } = {}) {
  let text
  let cut = false
  if (!isCompressed(file)) {
    const handle = await fs.promises.open(file, 'r')
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, maxBytes)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, size - length)
      text = buffer.subarray(0, bytesRead)
      cut = size > length
    } finally {
      await handle.close()
    }
  } else {
    text = await new Promise((resolve, reject) => {
      const { stream, close } = openStream(file)
      let chunks = []
      let kept = 0
      let total = 0
      stream.on('data', chunk => {
        total += chunk.length
        if (total > maxInflated) { close(); resolve(null); return }
        chunks.push(chunk)
        kept += chunk.length
        while (chunks.length > 1 && kept - chunks[0].length >= maxBytes) kept -= chunks.shift().length
      })
      stream.on('end', () => {
        const all = Buffer.concat(chunks)
        cut = total > all.length || all.length > maxBytes
        resolve(all.subarray(Math.max(0, all.length - maxBytes)))
      })
      stream.on('error', error => { close(); reject(error) })
    })
    if (text === null) return null
  }
  const lines = text.toString('utf8').split('\n')
  if (cut) lines.shift()
  return lines.flatMap(line => {
    if (!line) return []
    try {
      const value = JSON.parse(line)
      return value !== null && typeof value === 'object' ? [value] : []
    } catch {
      return []
    }
  })
}

module.exports = { readLinesFromStart, readLinesFromEnd }
