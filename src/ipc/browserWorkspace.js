// Workspace previews have their own origin per tab. Only web assets in the approved workspace
// are served there, and ordinary browser sessions have no handler for this protocol.
const fs = require('node:fs')
const path = require('node:path')
const { Readable } = require('node:stream')
const { sameOrInside } = require('../localFiles/roots.js')
const { resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { extensionOf, previewKind } = require('../remoteFiles/fileKind.js')

const WORKSPACE_SCHEME = 'ezshell-workspace'
const DOCUMENT_TYPES = new Map([
  ['html', 'text/html'], ['htm', 'text/html'], ['xhtml', 'application/xhtml+xml'], ['svg', 'image/svg+xml']
])
const ASSET_TYPES = new Map([
  ['css', 'text/css'], ['js', 'text/javascript'], ['mjs', 'text/javascript'], ['json', 'application/json'],
  ['avif', 'image/avif'], ['woff', 'font/woff'], ['woff2', 'font/woff2'], ['ttf', 'font/ttf'], ['otf', 'font/otf']
])
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)

function webAssetType(relative) {
  const ext = extensionOf(relative)
  const media = previewKind(relative)
  return DOCUMENT_TYPES.get(ext) ?? ASSET_TYPES.get(ext) ?? (media.kind === 'image' ? media.mime : null)
}

function safeParts(parts) {
  return parts.every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !/[\\/:\x00-\x1f\x7f]/.test(part))
}

// A chat link outside any workspace serves its own folder, which can be a broad one (the home folder).
// There, dot files and folders (.claude.json, .ssh) and JSON stay out: config secrets live there.
function linkFolderParts(parts) {
  return safeParts(parts) && parts.every(part => !part.startsWith('.')) && extensionOf(parts.at(-1) ?? '') !== 'json'
}

/** The folder of a file the conversation linked: a local folder, never a drive root */
async function resolveLinkFolder(folder) {
  const entry = await resolveLocalPreviewPath(folder)
  if (!entry.stat.isDirectory() || path.parse(entry.path).root === entry.path) throw new Error('Unavailable folder')
  return entry.path
}

function workspacePagePath(value, host) {
  try {
    const url = new URL(value)
    if (url.protocol !== `${WORKSPACE_SCHEME}:` || url.host !== host || url.username || url.password) return null
    const parts = url.pathname.slice(1).split('/').map(decodeURIComponent)
    return safeParts(parts) ? parts.join('/') : null
  } catch { return null }
}

function workspaceDocument(value, host) {
  const relative = workspacePagePath(value, host)
  return relative && DOCUMENT_TYPES.has(extensionOf(relative)) ? relative : null
}

async function resolveAsset(root, relative, linkFolder = false) {
  const allowedParts = linkFolder ? linkFolderParts : safeParts
  if (!allowedParts(relative.split('/'))) throw new Error('Unavailable file')
  const entry = await resolveLocalPreviewPath(path.join(root, relative))
  const inside = path.relative(root, entry.path)
  if (!entry.stat.isFile() || !sameOrInside(root, entry.path) || !allowedParts(inside.split(path.sep))) throw new Error('Unavailable file')
  return entry
}

async function workspacePreview(root, relative, linkFolder = false) {
  if (typeof relative !== 'string' || !safeParts(relative.split('/')) || !DOCUMENT_TYPES.has(extensionOf(relative))) {
    throw new Error('Unsupported file')
  }
  await resolveAsset(root, relative, linkFolder)
  return { root, path: relative.split('/').map(encodeURIComponent).join('/'), linkFolder }
}

async function serveWorkspaceAsset(request, previews) {
  let handle
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
    const { host } = new URL(request.url)
    const preview = previews.get(host)
    const relative = preview && workspacePagePath(request.url, host)
    const type = relative && webAssetType(relative)
    if (!type) return new Response(null, { status: 404 })
    const entry = await resolveAsset(preview.root, relative, preview.linkFolder)
    handle = await fs.promises.open(entry.path, READ_FLAGS)
    const opened = await handle.stat()
    if (previews.get(host) !== preview || !opened.isFile() || opened.dev !== entry.stat.dev || opened.ino !== entry.stat.ino || opened.birthtimeMs !== entry.stat.birthtimeMs) {
      throw new Error('File changed')
    }
    const headers = { 'Content-Type': type, 'Content-Length': String(opened.size), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    if (request.method === 'HEAD') return new Response(null, { headers })
    const response = new Response(Readable.toWeb(handle.createReadStream()), { headers })
    handle = null // The stream owns the handle from here.
    return response
  } catch {
    return new Response(null, { status: 404 })
  } finally {
    await handle?.close().catch(() => {})
  }
}

module.exports = { WORKSPACE_SCHEME, workspaceDocument, workspacePreview, serveWorkspaceAsset, resolveLinkFolder }
