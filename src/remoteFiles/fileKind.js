// How a server file is shown in the file window, decided by its name.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.

const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}
const PDF_TYPE = 'application/pdf'

function extensionOf(name) {
  const base = String(name || '').split('/').pop() || ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** { kind: 'image' | 'pdf', mime } for those files; everything else is shown as text. */
function previewKind(name) {
  const extension = extensionOf(name)
  if (IMAGE_TYPES[extension]) return { kind: 'image', mime: IMAGE_TYPES[extension] }
  if (extension === 'pdf') return { kind: 'pdf', mime: PDF_TYPE }
  return { kind: 'text', mime: null }
}

module.exports = { previewKind, extensionOf }
