const MAGIC = 0xcafebabe
const invalidClass = () => new Error('클래스 파일 형식이 올바르지 않습니다.')
const CONSTANT_SIZES = new Map([[3, 4], [4, 4], [5, 8], [6, 8], [8, 2], [9, 4], [10, 4],
  [11, 4], [12, 4], [15, 3], [16, 2], [17, 4], [18, 4], [19, 2], [20, 2]])

/** JVM strings encode UTF-16 code units in modified UTF-8, including surrogate pairs. */
function decodeName(bytes) {
  const characters = []
  for (let offset = 0; offset < bytes.length;) {
    const first = bytes[offset++]
    if (first > 0 && first < 0x80) characters.push(String.fromCharCode(first))
    else if (first >= 0xc2 && first <= 0xdf) {
      const next = bytes[offset++]
      if (next === undefined || (next & 0xc0) !== 0x80) throw invalidClass()
      characters.push(String.fromCharCode(((first & 0x1f) << 6) | (next & 0x3f)))
    } else if (first >= 0xe0 && first <= 0xef) {
      const second = bytes[offset++]
      const third = bytes[offset++]
      if (third === undefined || (second & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80 || (first === 0xe0 && second < 0xa0)) throw invalidClass()
      characters.push(String.fromCharCode(((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f)))
    } else throw invalidClass()
  }
  const name = characters.join('')
  if (!name || /[.;[\p{Cs}\u0000-\u001f]/u.test(name) || name.split('/').some(part => !part)) throw invalidClass()
  return name
}

function readClassInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10 || buffer.readUInt32BE(0) !== MAGIC) throw invalidClass()
  const major = buffer.readUInt16BE(6)
  const count = buffer.readUInt16BE(8)
  if (major < 45 || count < 2) throw invalidClass()
  let offset = 10
  const take = length => {
    if (length > buffer.length - offset) throw invalidClass()
    const bytes = buffer.subarray(offset, offset + length)
    offset += length
    return bytes
  }
  const short = () => take(2).readUInt16BE(0)
  const classes = new Map()
  const strings = new Map()
  for (let index = 1; index < count; index++) {
    const tag = take(1)[0]
    if (tag === 1) strings.set(index, take(short()))
    else if (tag === 7) classes.set(index, short())
    else {
      const size = CONSTANT_SIZES.get(tag)
      if (!size) throw invalidClass()
      take(size)
      if ((tag === 5 || tag === 6) && ++index >= count) throw invalidClass()
    }
  }
  take(2) // access_flags
  const classIndex = short()
  take(2) // super_class
  const name = strings.get(classes.get(classIndex))
  if (!name) throw invalidClass()
  return { name: decodeName(name), major }
}

module.exports = { readClassInfo }
