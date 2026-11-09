// Turning database rows into plain values for the window, within the row and size limits.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.

const LIMITS = {
  maxRows: 1000,
  maxBytes: 50 * 1024 * 1024,
  // One cell longer than this is cut; the grid shows that it was
  maxCellChars: 64 * 1024,
  // A query the server does not stop by itself is given up this long after its own limit
  queryTimeoutMs: 30000
}

const HEX_PREVIEW_BYTES = 256

/** A cell the window can show and the IPC can carry: null, number, boolean or string. */
function toCell(value, maxCellChars = LIMITS.maxCellChars) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) {
    const hex = value.subarray(0, HEX_PREVIEW_BYTES).toString('hex')
    return `0x${hex}${value.length > HEX_PREVIEW_BYTES ? `… (${value.length} bytes)` : ''}`
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString()
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > maxCellChars ? `${text.slice(0, maxCellChars)}… (${text.length}자 중 일부)` : text
}

/** Rough size of a converted row, for the total size limit. */
function rowBytes(cells) {
  let bytes = 16
  for (const cell of cells) bytes += typeof cell === 'string' ? cell.length * 2 : 8
  return bytes
}

/**
 * Collects rows until the row or size limit. `add(row)` returns false once nothing more is wanted;
 * `truncatedBy` is then 'rows' or 'bytes'.
 */
function createCollector({ maxRows = LIMITS.maxRows, maxBytes = LIMITS.maxBytes, maxCellChars = LIMITS.maxCellChars } = {}) {
  const rows = []
  let bytes = 0
  let truncatedBy = null
  return {
    add(raw) {
      if (truncatedBy) return false
      if (rows.length >= maxRows) {
        truncatedBy = 'rows'
        return false
      }
      const cells = raw.map((value) => toCell(value, maxCellChars))
      bytes += rowBytes(cells)
      if (bytes > maxBytes) {
        truncatedBy = 'bytes'
        return false
      }
      rows.push(cells)
      return true
    },
    get rows() { return rows },
    get truncatedBy() { return truncatedBy },
    get isFull() { return truncatedBy !== null }
  }
}

module.exports = { LIMITS, toCell, rowBytes, createCollector }
