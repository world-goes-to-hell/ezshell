const { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } = require('fs')
const { randomUUID } = require('crypto')
const { tmpdir } = require('os')
const { join } = require('path')

const MAX_TEXT = 1024 * 1024 - 16
const MAX_PIXELS = 24 * 1024 * 1024

function createLocalTerminalClipboard(clipboard, platform = process.platform) {
  let directory
  const files = []

  function read() {
    const text = clipboard.readText()
    if (text.length > MAX_TEXT) throw new Error('붙여넣을 텍스트가 너무 깁니다.')
    if (text) return text

    const image = clipboard.readImage()
    if (image.isEmpty()) return ''
    const { width, height } = image.getSize()
    if (width * height > MAX_PIXELS) throw new Error('붙여넣을 이미지가 너무 큽니다.')

    directory ??= mkdtempSync(join(tmpdir(), 'ezshell-clipboard-'))
    const file = join(directory, randomUUID() + '.png')
    if (/[\x00-\x1f\x7f]/.test(file)) throw new Error('임시 이미지 경로를 붙여넣을 수 없습니다.')
    writeFileSync(file, image.toPNG(), { flag: 'wx', mode: 0o600 })
    files.push(file)
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

  return { read, dispose }
}

module.exports = { createLocalTerminalClipboard }
