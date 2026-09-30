import { describe, it, expect } from 'vitest'
import sftpSymlinks from './sftpSymlinks.js'

const { resolveSymlinks, joinRemotePath } = sftpSymlinks

const dirStat = { isDirectory: () => true }
const fileStat = { isDirectory: () => false }

// Fake remote filesystem: path -> stat result, plus link targets
function fakeFs({ stats = {}, links = {} } = {}) {
  const calls = { stat: [], readlink: [] }
  return {
    calls,
    stat: async (p) => {
      calls.stat.push(p)
      if (!stats[p]) throw new Error('No such file')
      return stats[p]
    },
    readlink: async (p) => {
      calls.readlink.push(p)
      if (!(p in links)) throw new Error('readlink failed')
      return links[p]
    }
  }
}

describe('joinRemotePath', () => {
  it('joins under the root without a double slash', () => {
    expect(joinRemotePath('/', 'etc')).toBe('/etc')
  })

  it('joins under a nested directory', () => {
    expect(joinRemotePath('/var/www', 'html')).toBe('/var/www/html')
  })

  it('ignores a trailing slash on the directory', () => {
    expect(joinRemotePath('/var/www/', 'html')).toBe('/var/www/html')
  })
})

describe('resolveSymlinks', () => {
  it('leaves regular entries untouched and sends no requests for them', async () => {
    const fs = fakeFs()
    const entries = [{ name: 'a', isSymlink: false }]
    const result = await resolveSymlinks('/home', entries, fs)
    expect(result).toEqual([{ name: 'a', isSymlink: false }])
    expect(fs.calls.stat).toEqual([])
    expect(fs.calls.readlink).toEqual([])
  })

  it('marks a link to a directory with its target', async () => {
    const fs = fakeFs({ stats: { '/srv/app': dirStat }, links: { '/srv/app': '/opt/app/current' } })
    const [entry] = await resolveSymlinks('/srv', [{ name: 'app', isSymlink: true }], fs)
    expect(entry).toMatchObject({ isSymlink: true, targetIsDirectory: true, isBrokenLink: false, linkTarget: '/opt/app/current' })
  })

  it('marks a link to a file as not a directory', async () => {
    const fs = fakeFs({ stats: { '/etc/localtime': fileStat }, links: { '/etc/localtime': '/usr/share/zoneinfo/Asia/Seoul' } })
    const [entry] = await resolveSymlinks('/etc', [{ name: 'localtime', isSymlink: true }], fs)
    expect(entry).toMatchObject({ targetIsDirectory: false, isBrokenLink: false })
  })

  it('marks a link whose target is missing as broken but keeps the target text', async () => {
    const fs = fakeFs({ links: { '/srv/old': '/gone' } })
    const [entry] = await resolveSymlinks('/srv', [{ name: 'old', isSymlink: true }], fs)
    expect(entry).toMatchObject({ targetIsDirectory: false, isBrokenLink: true, linkTarget: '/gone' })
  })

  it('still resolves the type when readlink fails', async () => {
    const fs = fakeFs({ stats: { '/srv/app': dirStat } })
    const [entry] = await resolveSymlinks('/srv', [{ name: 'app', isSymlink: true }], fs)
    expect(entry.targetIsDirectory).toBe(true)
    expect(entry.linkTarget).toBeUndefined()
  })

  it('keeps the original order and does not mutate the input', async () => {
    const fs = fakeFs({ stats: { '/d/l': dirStat }, links: { '/d/l': 'x' } })
    const entries = [{ name: 'a', isSymlink: false }, { name: 'l', isSymlink: true }, { name: 'b', isSymlink: false }]
    const snapshot = JSON.parse(JSON.stringify(entries))
    const result = await resolveSymlinks('/d', entries, fs)
    expect(result.map(e => e.name)).toEqual(['a', 'l', 'b'])
    expect(entries).toEqual(snapshot)
  })

  it('gives up on a link whose requests never answer, without failing the listing', async () => {
    const never = () => new Promise(() => {})
    const fs = { stat: never, readlink: never }
    const entries = [{ name: 'a', isSymlink: false }, { name: 'hung', isSymlink: true }]
    const [regular, hung] = await resolveSymlinks('/srv', entries, fs, 16, 20)
    expect(regular).toEqual({ name: 'a', isSymlink: false })
    // unknown target: not expandable, but not claimed to be broken either
    expect(hung).toMatchObject({ targetIsDirectory: false, isBrokenLink: false, linkTarget: undefined })
  })

  it('limits how many links are resolved at the same time', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const slow = async (value) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 2))
      inFlight--
      return value
    }
    const fs = { stat: () => slow(dirStat), readlink: () => slow('t') }
    const entries = Array.from({ length: 20 }, (_, i) => ({ name: `l${i}`, isSymlink: true }))
    const result = await resolveSymlinks('/lib', entries, fs, 3)
    expect(result.every(e => e.targetIsDirectory)).toBe(true)
    // each link runs stat and readlink together, so at most 2 requests per slot
    expect(maxInFlight).toBeLessThanOrEqual(6)
  })
})
