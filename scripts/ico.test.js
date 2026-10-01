import { describe, it, expect } from 'vitest'
import ico from './ico.cjs'

const { encodeBmpEntry, packIco } = ico

describe('encodeBmpEntry', () => {
  it('writes a 32-bit DIB with doubled height, bottom-up BGRA rows and an empty AND mask', () => {
    // 2x2 RGBA, top row red / green, bottom row blue / white (half transparent)
    const rgba = Uint8Array.from([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 128
    ])

    const bmp = encodeBmpEntry(2, rgba)

    expect(bmp.readUInt32LE(0)).toBe(40) // header size
    expect(bmp.readInt32LE(4)).toBe(2) // width
    expect(bmp.readInt32LE(8)).toBe(4) // height x2 (XOR + AND masks)
    expect(bmp.readUInt16LE(14)).toBe(32) // bits per pixel
    // First stored row is the bottom row: blue, then white with alpha 128
    expect([...bmp.subarray(40, 48)]).toEqual([255, 0, 0, 255, 255, 255, 255, 128])
    expect([...bmp.subarray(48, 56)]).toEqual([0, 0, 255, 255, 0, 255, 0, 255])
    // AND mask: one 4-byte row per pixel row, all zero (alpha carries transparency)
    expect(bmp.length).toBe(40 + 16 + 2 * 4)
    expect([...bmp.subarray(56)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })
})

describe('packIco', () => {
  it('writes the header, one directory entry per image and the image data after it', () => {
    const small = Buffer.from([1, 2, 3])
    const big = Buffer.from([9, 9, 9, 9, 9])

    const file = packIco([{ size: 16, data: small }, { size: 256, data: big }])

    expect(file.readUInt16LE(0)).toBe(0) // reserved
    expect(file.readUInt16LE(2)).toBe(1) // type: icon
    expect(file.readUInt16LE(4)).toBe(2) // image count
    // entry 1
    expect(file[6]).toBe(16)
    expect(file[7]).toBe(16)
    expect(file.readUInt16LE(10)).toBe(1) // planes
    expect(file.readUInt16LE(12)).toBe(32) // bpp
    expect(file.readUInt32LE(14)).toBe(3) // bytes
    expect(file.readUInt32LE(18)).toBe(6 + 32) // offset after header + 2 entries
    // entry 2: 256 is stored as 0
    expect(file[22]).toBe(0)
    expect(file[23]).toBe(0)
    expect(file.readUInt32LE(30)).toBe(5)
    expect(file.readUInt32LE(34)).toBe(6 + 32 + 3)
    expect([...file.subarray(38)]).toEqual([1, 2, 3, 9, 9, 9, 9, 9])
  })
})
