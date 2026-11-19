const { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } = require('fs')
const { randomUUID } = require('crypto')
const { tmpdir } = require('os')
const { join } = require('path')

const MAX_TEXT = 1024 * 1024 - 16
const MAX_PIXELS = 24 * 1024 * 1024
const MAX_IMAGE_BYTES = MAX_PIXELS * 4

function createLocalTerminalClipboard(clipboard, nativeImage, platform = process.platform) {
  let directory
  const files = []

  async function read() {
    const text = await clipboard.readText()
    if (text.length > MAX_TEXT) throw new Error('붙여넣을 텍스트가 너무 깁니다.')
    if (text) return { text }

    const items = await clipboard.read()
    for (const type of ['image/png', 'image/jpeg']) {
      const item = items.find(candidate => candidate.types.includes(type))
      if (item) return { image: { item, type } }
    }
    return { text: '' }
  }

  async function decodeImage({ item, type }) {
    const blob = await item.getType(type)
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('붙여넣을 이미지가 너무 큽니다.')
    const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()))
    if (image.isEmpty()) throw new Error('클립보드 이미지를 읽지 못했습니다.')
    const { width, height } = image.getSize()
    if (width * height > MAX_PIXELS) throw new Error('붙여넣을 이미지가 너무 큽니다.')
    return image
  }

  function storeImage(image) {
    directory ??= mkdtempSync(join(tmpdir(), 'ezshell-clipboard-'))
    const file = join(directory, randomUUID() + '.png')
    if (/[\x00-\x1f\x7f]/.test(file)) throw new Error('임시 이미지 경로를 붙여넣을 수 없습니다.')
    writeFileSync(file, image.toPNG(), { flag: 'wx', mode: 0o600 })
    files.push(file)
    return file
  }

  function saveImage(image) {
    const file = storeImage(image)
    if (platform === 'win32') return /[\s'&()$!;\x60]/.test(file) ? "'" + file.replace(/'/g, "''") + "'" : file
    return /[^\w./-]/.test(file) ? "'" + file.replace(/'/g, "'\\''") + "'" : file
  }

  function dispose() {
    for (const file of files.splice(0)) {
      try { unlinkSync(file) } catch {}
    }
    if (!directory) return
    try { rmdirSync(directory) } catch {}
    directory = undefined
  }

  return { read, decodeImage, storeImage, saveImage, dispose }
}

module.exports = { createLocalTerminalClipboard }
