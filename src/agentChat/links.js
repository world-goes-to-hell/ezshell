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
// A place in a file: Codex writes "D:/proj/README.md:187" (and ":12:5"), others "app.py#L42" / "#L42-L50"
const LINE_SUFFIX = /^(.+?)(?::(\d{1,7})(?::\d{1,7})?|#L(\d{1,7})(?:-L?\d{1,7})?)$/
// A relative file link (Claude writes "docs/x.md", "../plan/a.md"): no scheme, no anchor, nothing a path cannot hold
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const NOT_IN_PATH = /[<>"|?*{}$\\]{2}|[<>"|?*{}$]/

/**
 * A link as main opens it, or null: { kind: 'path', path, key, line? } | { kind: 'url', url, key }.
 * `base`: the agent's folder, for a relative link (none: relative links are refused).
 */
function linkTarget(href, platform = process.platform, base = null) {
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
  // The line is where to open the file, not part of its name
  let line
  const place = LINE_SUFFIX.exec(value)
  if (place && !/^[a-z]$/i.test(place[1])) {
    value = place[1]
    line = Number(place[2] ?? place[3])
  }
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (!isLocalFilePath(value)) {
    const relative = base && isLocalFilePath(base) && !value.startsWith('#') && !SCHEME.test(value)
      && !NOT_IN_PATH.test(value) && !/^[\\/]/.test(value) && /[\w.]/.test(value)
    if (!relative) return null
    value = paths.resolve(base, value)
    if (!isLocalFilePath(value)) return null
  }
  const normalized = paths.normalize(value)
  const key = platform === 'win32' ? normalized.toLowerCase() : normalized
  return line ? { kind: 'path', path: normalized, key, line } : { kind: 'path', path: normalized, key }
}

/** The keys of the openable links in an answer's text (`base`: the agent's folder, for relative links) */
function linkKeysIn(text, platform = process.platform, base = null) {
  if (typeof text !== 'string' || !text) return []
  const keys = []
  const add = href => {
    const target = linkTarget(href, platform, base)
    if (target) keys.push(target.key)
  }
  for (const match of text.matchAll(MARKDOWN_TARGET)) add(match[1] ?? match[2])
  for (const match of text.matchAll(AUTOLINK)) add(match[1])
  for (const match of text.matchAll(BARE_URL)) add(match[0].replace(/[.,;:!?]+$/, ''))
  return [...new Set(keys)]
}

module.exports = { linkTarget, linkKeysIn }
