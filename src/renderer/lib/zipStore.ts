// A ZIP archive without compression ("stored" entries), enough for an .xlsx file: a spreadsheet is a
// ZIP of a few XML files, and a query result is at most a thousand rows. Written here instead of
// pulling in a spreadsheet library for one export button.

export interface ZipEntry {
  /** Path inside the archive, with forward slashes */
  name: string
  data: Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// 1980-01-01 00:00: a fixed time, so the same content gives the same file
const DOS_TIME = 0
const DOS_DATE = 0x21
// Bit 11: names are UTF-8
const FLAGS = 0x0800

/** The bytes of a ZIP archive holding the entries as they are (no compression) */
export function zipStore(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)          // version needed
    local.setUint16(6, FLAGS, true)
    local.setUint16(8, 0, true)           // method: stored
    local.setUint16(10, DOS_TIME, true)
    local.setUint16(12, DOS_DATE, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, size, true)       // compressed size
    local.setUint32(22, size, true)       // real size
    local.setUint16(26, name.length, true)
    local.setUint16(28, 0, true)          // extra length
    parts.push(new Uint8Array(local.buffer), name, entry.data)

    const header = new DataView(new ArrayBuffer(46))
    header.setUint32(0, 0x02014b50, true)
    header.setUint16(4, 20, true)         // version made by
    header.setUint16(6, 20, true)         // version needed
    header.setUint16(8, FLAGS, true)
    header.setUint16(10, 0, true)
    header.setUint16(12, DOS_TIME, true)
    header.setUint16(14, DOS_DATE, true)
    header.setUint32(16, crc, true)
    header.setUint32(20, size, true)
    header.setUint32(24, size, true)
    header.setUint16(28, name.length, true)
    header.setUint32(42, offset, true)    // where the local header starts
    central.push(new Uint8Array(header.buffer), name)

    offset += 30 + name.length + size
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)

  const out = new Uint8Array(offset + centralSize + 22)
  let at = 0
  for (const part of [...parts, ...central, new Uint8Array(end.buffer)]) {
    out.set(part, at)
    at += part.length
  }
  return out
}
