const path = require('path')
const { fileURLToPath } = require('url')
const { isLocalFilePath } = require('../localKeyPath.js')

// Links in an agent's answers that the chat view lets the user open: files and folders on this PC
// (in ezShell's file window or the file manager) and web pages (in the browser). The window sends
// back the link it shows; main opens it only when that link was in the conversation it read.

// Markdown link targets: [text](target) and [text](<target with spaces>)
const MARKDOWN_TARGET = /\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g
const AUTOLINK = /<((?:https?|file):\/\/[^>\s]+)>/g
const BARE_URL = /\bhttps?:\/\/[^\s<>()[\]"'`]+/g

/** A link as main opens it, or null: { kind: 'path', path, key } | { kind: 'url', url, key } */
function linkTarget(href, platform = process.platform) {
  if (typeof href !== 'string' || !href || href.length > 4096 || /[\u0000-\u001f\u007f]/.test(href)) return null
  let value = href.trim()
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value).href
      return { kind: 'url', url, key: url }
    } catch {
      return null
    }
  }
  if (/^file:\/\//i.test(value)) {
    try { value = fileURLToPath(value, { windows: platform === 'win32' }) } catch { return null }
  } else {
    // A link target may be percent-encoded (markdown-it writes spaces as %20)
    try { value = decodeURIComponent(value) } catch { return null }
  }
  if (!isLocalFilePath(value)) return null
  const normalized = platform === 'win32' ? path.win32.normalize(value) : path.posix.normalize(value)
  return { kind: 'path', path: normalized, key: platform === 'win32' ? normalized.toLowerCase() : normalized }
}

/** The keys of the openable links in an answer's text */
function linkKeysIn(text, platform = process.platform) {
  if (typeof text !== 'string' || !text) return []
  const keys = []
  const add = href => {
    const target = linkTarget(href, platform)
    if (target) keys.push(target.key)
  }
  for (const match of text.matchAll(MARKDOWN_TARGET)) add(match[1] ?? match[2])
  for (const match of text.matchAll(AUTOLINK)) add(match[1])
  for (const match of text.matchAll(BARE_URL)) add(match[0].replace(/[.,;:!?]+$/, ''))
  return [...new Set(keys)]
}

module.exports = { linkTarget, linkKeysIn }
