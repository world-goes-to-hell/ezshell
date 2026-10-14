// Host key blobs in SSH wire format, for tests only (not copied into the build).

function sshString(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  return Buffer.concat([length, body])
}

/** A host key blob as ssh2 hands it to hostVerifier: string key type, then key data */
function hostKey(type = 'ssh-ed25519', fill = 1) {
  return Buffer.concat([sshString(type), sshString(Buffer.alloc(32, fill))])
}

module.exports = { hostKey }
