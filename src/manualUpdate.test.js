import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { readRelease, checkLatest, releasePageUrl } from './manualUpdate.js'

const release = (overrides = {}) => ({
  tag_name: 'v2.19.0',
  draft: false,
  prerelease: false,
  html_url: 'https://evil.example/download',
  assets: [{ name: 'ezShell-2.19.0-arm64.dmg' }, { name: 'ezShell-2.19.0-x64.dmg' }, { name: 'ezShell-Setup-2.19.0.exe' }],
  ...overrides
})
const here = { currentVersion: '2.18.2', arch: 'arm64' }

describe('readRelease (update notice for builds that cannot update themselves)', () => {
  it('reports a newer release that has the download for this architecture', () => {
    expect(readRelease(release(), here)).toEqual({
      status: 'available',
      version: '2.19.0',
      url: 'https://github.com/world-goes-to-hell/ezshell/releases/tag/v2.19.0'
    })
  })

  it('builds the page address itself instead of using the one in the response', () => {
    expect(readRelease(release(), here).url).toBe(releasePageUrl('2.19.0'))
  })

  it('opens the project releases when no specific version is known', () => {
    expect(releasePageUrl()).toBe('https://github.com/world-goes-to-hell/ezshell/releases')
  })

  it('stays quiet until the macOS file for this architecture is attached', () => {
    expect(readRelease(release({ assets: [{ name: 'ezShell-Setup-2.19.0.exe' }] }), here).status).toBe('not-available')
    expect(readRelease(release({ assets: [{ name: 'ezShell-2.19.0-x64.dmg' }] }), here).status).toBe('not-available')
    expect(readRelease(release({ assets: undefined }), here).status).toBe('not-available')
  })

  it('compares versions by number, not by text', () => {
    expect(readRelease(release({ tag_name: 'v2.18.10', assets: [{ name: 'ezShell-2.18.10-arm64.dmg' }] }), { ...here, currentVersion: '2.18.9' }).status).toBe('available')
    expect(readRelease(release({ tag_name: 'v2.18.2' }), here).status).toBe('not-available')
    expect(readRelease(release({ tag_name: 'v2.17.9' }), here).status).toBe('not-available')
  })

  it('ignores drafts and pre-releases', () => {
    expect(readRelease(release({ draft: true }), here).status).toBe('not-available')
    expect(readRelease(release({ prerelease: true }), here).status).toBe('not-available')
  })

  it('rejects a tag that is not a plain version', () => {
    expect(() => readRelease(release({ tag_name: 'v2.19.0/../../x' }), here)).toThrow()
    expect(() => readRelease(release({ tag_name: 'latest' }), here)).toThrow()
    expect(() => readRelease(null, here)).toThrow()
  })
})

describe('checkLatest', () => {
  const respond = (statusCode, body) => (url, options, onResponse) => {
    const req = new EventEmitter()
    req.destroy = (error) => { if (error) req.emit('error', error) }
    const res = new EventEmitter()
    res.statusCode = statusCode
    res.resume = () => {}
    setImmediate(() => {
      onResponse(res)
      if (statusCode === 200) {
        res.emit('data', Buffer.from(body))
        res.emit('end')
      }
    })
    return req
  }

  it('reads the latest release from the answer', async () => {
    const result = await checkLatest({ ...here, request: respond(200, JSON.stringify(release())) })
    expect(result).toMatchObject({ status: 'available', version: '2.19.0' })
  })

  it('fails on an error status or a broken body', async () => {
    await expect(checkLatest({ ...here, request: respond(403, '') })).rejects.toThrow('403')
    await expect(checkLatest({ ...here, request: respond(200, '{not json') })).rejects.toThrow()
  })
})
