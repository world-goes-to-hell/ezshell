import { describe, it, expect } from 'vitest'
import algorithmsModule from './sshAlgorithms.js'
import connectionTestModule from './sshConnectionTest.js'

const { SSH_ALGORITHMS, legacyAlgorithms } = algorithmsModule
const { buildOptions } = connectionTestModule

describe('SSH_ALGORITHMS', () => {
  it('adds the older key exchanges an old server may be limited to, after ssh2 defaults', () => {
    expect(SSH_ALGORITHMS.kex.append).toEqual(expect.arrayContaining([
      'diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'
    ]))
    // Appended, never prepended or replacing: a modern server still gets a modern algorithm
    for (const category of Object.values(SSH_ALGORITHMS)) {
      expect(Object.keys(category)).toEqual(['append'])
    }
  })

  it('also adds CBC ciphers, ssh-dss host keys and older MACs', () => {
    expect(SSH_ALGORITHMS.cipher.append).toEqual(expect.arrayContaining(['aes128-cbc', 'aes256-cbc', '3des-cbc']))
    expect(SSH_ALGORITHMS.serverHostKey.append).toContain('ssh-dss')
    expect(SSH_ALGORITHMS.hmac.append).toContain('hmac-md5')
  })

  it('leaves out what the runtime does not support, since ssh2 refuses unknown names', () => {
    const supported = { kex: ['diffie-hellman-group14-sha1'], serverHostKey: [], cipher: ['aes128-cbc'], hmac: [] }
    expect(legacyAlgorithms(supported)).toEqual({
      kex: { append: ['diffie-hellman-group14-sha1'] },
      serverHostKey: { append: [] },
      cipher: { append: ['aes128-cbc'] },
      hmac: { append: [] }
    })
  })
})

describe('buildOptions', () => {
  const config = { host: 'old.example', username: 'root', authType: 'password', password: 'pw' }

  it('gives the target and the jump host the same algorithms', () => {
    const options = buildOptions({ ...config, useJumpHost: true, jumpHost: 'bastion', jumpAuthType: 'password', jumpPassword: 'p' }, () => '')
    expect(options.target.algorithms).toEqual(SSH_ALGORITHMS)
    expect(options.jump.algorithms).toEqual(SSH_ALGORITHMS)
  })
})
