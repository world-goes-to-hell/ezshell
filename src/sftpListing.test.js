import { describe, it, expect, vi } from 'vitest'
import { readDirectory } from './sftpListing.js'

/** An SFTP session whose folder answers `parts` one after another, then the end code */
function fakeSftp(parts, { endWith = 'eof', failAt = -1 } = {}) {
  let at = 0
  const calls = []
  return {
    calls,
    opendir: (path, cb) => { calls.push(`opendir ${path}`); cb(undefined, Buffer.from('h')) },
    readdir: (handle, cb) => {
      if (at === failAt) return cb(Object.assign(new Error('Failure'), { code: 4 }))
      if (at < parts.length) return cb(undefined, parts[at++])
      if (endWith === 'empty') return cb(undefined, [])
      cb(Object.assign(new Error('EOF'), { code: 1 }))
    },
    close: (handle, cb) => { calls.push('close'); cb() }
  }
}

const names = (from, count) => Array.from({ length: count }, (_, i) => ({ filename: `f${from + i}` }))

describe('readDirectory', () => {
  it('joins the parts and closes the folder', async () => {
    const sftp = fakeSftp([names(0, 100), names(100, 100), names(200, 30)])
    const entries = await readDirectory(sftp, '/var/log')
    expect(entries.map(e => e.filename)).toEqual(names(0, 230).map(e => e.filename))
    expect(sftp.calls).toEqual(['opendir /var/log', 'close'])
  })

  it('reports the count as entries arrive, not for a small folder', async () => {
    const onProgress = vi.fn()
    await readDirectory(fakeSftp([names(0, 100), names(100, 100), names(200, 100), names(300, 100), names(400, 100)]), '/big', onProgress, 200)
    expect(onProgress.mock.calls).toEqual([[200], [400]])
    const quiet = vi.fn()
    await readDirectory(fakeSftp([names(0, 100)]), '/small', quiet, 200)
    expect(quiet).not.toHaveBeenCalled()
  })

  it('takes an empty answer as the end', async () => {
    expect(await readDirectory(fakeSftp([names(0, 3)], { endWith: 'empty' }), '/x')).toHaveLength(3)
  })

  it('fails with the server error and still closes the folder', async () => {
    const sftp = fakeSftp([names(0, 100)], { failAt: 1 })
    await expect(readDirectory(sftp, '/x')).rejects.toThrow('Failure')
    expect(sftp.calls).toContain('close')
  })
})
