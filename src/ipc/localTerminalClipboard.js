const { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } = require('fs')
const { open } = require('node:fs/promises')
const { randomUUID } = require('crypto')
const { tmpdir } = require('os')
const { join } = require('path')

const MAX_TEXT = 1024 * 1024 - 16
const MAX_PIXELS = 24 * 1024 * 1024
const MAX_IMAGE_BYTES = MAX_PIXELS * 4

function checkedText(text) {
  if (text.length > MAX_TEXT) throw new Error('붙여넣을 텍스트가 너무 깁니다.')
  return text
}

function createLocalTerminalClipboard(clipboard, nativeImage, platform = process.platform) {
  let directory
  const files = new Set()

  async function read({ includeImageWithText = false } = {}) {
    if (!includeImageWithText) {
      const text = checkedText(await clipboard.readText())
      if (text) return { text }
    }
    const items = await clipboard.read()
    const plain = includeImageWithText && items.find(item => item.types.includes('text/plain'))
    const text = plain ? checkedText(await (await plain.getType('text/plain')).text()) : ''
    for (const type of ['image/png', 'image/jpeg']) {
      const item = items.find(candidate => candidate.types.includes(type))
      if (item) return { text, image: { item, type } }
    }
    return { text }
  }

  async function decodeImage({ item, type }) {
    const blob = await item.getType(type)
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('붙여넣을 이미지가 너무 큽니다.')
    return decodeBuffer(Buffer.from(await blob.arrayBuffer()))
  }

  function decodeBuffer(buffer) {
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) throw new Error('이미지를 읽지 못했습니다.')
    const { width, height } = image.getSize()
    if (width * height > MAX_PIXELS) throw new Error('이미지가 너무 큽니다.')
    return image
  }

  async function decodeImageFile(path) {
    const file = await open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error('이미지 파일을 선택해 주세요.')
      if (stat.size > MAX_IMAGE_BYTES) throw new Error('이미지가 너무 큽니다.')
      const data = Buffer.alloc(stat.size)
      const { bytesRead } = await file.read(data, 0, data.length, 0)
      return decodeBuffer(data.subarray(0, bytesRead))
    } finally {
      await file.close()
    }
  }

  function storeImage(image) {
    directory ??= mkdtempSync(join(tmpdir(), 'ezshell-clipboard-'))
    const file = join(directory, randomUUID() + '.png')
    if (/[\x00-\x1f\x7f]/.test(file)) throw new Error('임시 이미지 경로를 붙여넣을 수 없습니다.')
    writeFileSync(file, image.toPNG(), { flag: 'wx', mode: 0o600 })
    files.add(file)
    return file
  }

  function discardImage(file) {
    if (!files.has(file)) return
    try {
      unlinkSync(file)
      files.delete(file)
    } catch {}
  }

  function saveImage(image) {
    const file = storeImage(image)
    if (platform === 'win32') return /[\s'&()$!;\x60]/.test(file) ? "'" + file.replace(/'/g, "''") + "'" : file
    return /[^\w./-]/.test(file) ? "'" + file.replace(/'/g, "'\\''") + "'" : file
  }

  function dispose() {
    for (const file of files) discardImage(file)
    files.clear()
    if (!directory) return
    try { rmdirSync(directory) } catch {}
    directory = undefined
  }

  return { read, decodeImage, decodeImageFile, storeImage, discardImage, saveImage, dispose }
}

module.exports = { createLocalTerminalClipboard }
