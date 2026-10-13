// Copies `size` bytes from one open file to another for the MCP transfer tools, a few pieces at a
// time: over SFTP every piece is a round trip, so one at a time would be slow on a distant server.
// Pieces are hashed and counted in order whatever order they arrive in.

const DEFAULT_CHUNK_BYTES = 32 * 1024
const DEFAULT_WINDOW = 16

class CopyStopped extends Error {}
/** The source ended before the size it had when the user was asked */
class SourceShrank extends Error {}

const quiet = (promise) => { promise.catch(() => {}); return promise }

/**
 * `readAt(position, length)` resolves with a Buffer of exactly `length` bytes, or fewer when the
 * source ends early. `writeAt(buffer, position)` writes all of it. Throws CopyStopped once `signal`
 * aborts and SourceShrank when the source is shorter than `size`. Before it returns or throws, every
 * read and write it started has ended, so the caller can remove a partial file right away.
 */
async function copyRange({ size, readAt, writeAt, signal, hash, onProgress = () => {}, chunkBytes = DEFAULT_CHUNK_BYTES, window = DEFAULT_WINDOW }) {
  const reads = []
  const writes = new Set()
  let next = 0
  let done = 0
  const assertRunning = () => {
    if (signal && signal.aborted) throw new CopyStopped()
  }
  try {
    assertRunning()
    while (next < size || reads.length > 0) {
      while (next < size && reads.length < window) {
        const position = next
        const length = Math.min(chunkBytes, size - position)
        reads.push({ position, length, data: quiet(readAt(position, length)) })
        next += length
      }
      const piece = reads.shift()
      const buffer = await piece.data
      assertRunning()
      if (buffer.length !== piece.length) throw new SourceShrank()
      hash.update(buffer)
      const writing = quiet(writeAt(buffer, piece.position))
      writes.add(writing)
      writing.then(() => writes.delete(writing), () => {})
      if (writes.size >= window) await Promise.race(writes)
      done += buffer.length
      onProgress(done)
    }
    await Promise.all(writes)
    assertRunning()
  } finally {
    await Promise.allSettled([...reads.map(piece => piece.data), ...writes])
  }
}

module.exports = { copyRange, CopyStopped, SourceShrank }
