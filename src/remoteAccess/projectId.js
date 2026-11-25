const path = require('node:path')
const { createHmac, randomBytes } = require('node:crypto')

// Stable within this PC session, shared by agents and browser tabs without exporting paths.
function createProjectId() {
  const secret = randomBytes(32)
  return key => {
    const resolved = path.resolve(key)
    return createHmac('sha256', secret)
      .update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('base64url')
  }
}

module.exports = { createProjectId }
