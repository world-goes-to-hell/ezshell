const { isPreviewLocalPath, resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { EDIT_MAX_BYTES } = require('./localRead.js')

async function resolveExplorerFile(requested) {
  if (!isPreviewLocalPath(requested, 'win32')) return null
  try {
    const { path, stat } = await resolveLocalPreviewPath(requested)
    return stat.isFile() ? { path, previewText: stat.size > EDIT_MAX_BYTES } : null
  } catch {
    return null
  }
}

module.exports = { resolveExplorerFile }
