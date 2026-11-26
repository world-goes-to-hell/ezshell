import { describe, expect, it, vi } from 'vitest'
import { findApacheBuild } from './apacheProviders.js'

const downloads = 'https://downloads.apache.org'
const archive = 'https://archive.apache.org/dist'
const hash = 'a1'.repeat(64)
const listing = (...links) => links.map(link => `<a href="${link}">${link}</a>`).join('\n')
const readFrom = (responses) => vi.fn(async url => responses[url] ?? null)

describe('Apache tool distributions', () => {
  it('selects the newest stable Tomcat in the requested series from the official directory', async () => {
    const base = `${downloads}/tomcat/tomcat-10/`
    const filename = 'apache-tomcat-10.1.100.zip'
    const url = `${base}v10.1.100/bin/${filename}`
    const read = readFrom({
      [base]: listing('v10.1.91/', 'v10.1.100/', 'v10.1.101-M1/', 'v10.0.300/', '/v10.1.400/', 'https://mirror.test/v10.1.999/'),
      [`${url}.sha512`]: `${hash.toUpperCase()} *${filename}\n`
    })
    const signal = new AbortController().signal
    expect(await findApacheBuild('tomcat', '10.1', { platform: 'win32', read, signal })).toEqual({
      tool: 'tomcat', series: '10.1', version: '10.1.100', archive: 'zip', url, sha512: hash,
      licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0'
    })
    expect(read.mock.calls.map(([url]) => url)).toEqual([base, `${url}.sha512`])
    expect(read).toHaveBeenLastCalledWith(`${url}.sha512`, expect.objectContaining({ maxBytes: 4096, signal }))
  })

  it.each([
    ['tomcat', '7', '/tomcat/tomcat-7/', 'v7.0.109/', 'v7.0.109/bin/apache-tomcat-7.0.109.tar.gz'],
    ['tomcat', '8.5', '/tomcat/tomcat-8/', 'v8.5.100/', 'v8.5.100/bin/apache-tomcat-8.5.100.tar.gz'],
    ['maven', '3.6', '/maven/maven-3/', '3.6.3/', '3.6.3/binaries/apache-maven-3.6.3-bin.tar.gz'],
    ['maven', '3.8', '/maven/maven-3/', '3.8.9/', '3.8.9/binaries/apache-maven-3.8.9-bin.tar.gz'],
    ['ant', '1.9', '/ant/binaries/', 'apache-ant-1.9.16-bin.tar.gz', 'apache-ant-1.9.16-bin.tar.gz']
  ])('reads the official archive for %s %s', async (tool, series, directory, link, file) => {
    const base = archive + directory
    const url = base + file
    const read = readFrom({ [base]: listing(link), [`${url}.sha512`]: hash })
    expect(await findApacheBuild(tool, series, { platform: 'linux', read })).toMatchObject({ tool, archive: 'tar.gz', url, sha512: hash })
    expect(read.mock.calls.map(([url]) => url)).toEqual([base, `${url}.sha512`])
  })

  it('looks in the official archive when no active release matches the Maven series', async () => {
    const directory = '/maven/maven-3/'
    const base = archive + directory
    const url = `${base}3.9.15/binaries/apache-maven-3.9.15-bin.zip`
    const read = readFrom({
      [downloads + directory]: listing('3.10.0/'),
      [base]: listing('3.9.15/', '3.9.9/'),
      [`${url}.sha512`]: hash
    })
    expect(await findApacheBuild('maven', '3.9', { platform: 'win32', read })).toMatchObject({ url, version: '3.9.15' })
  })

  it('skips a partially published newest release when its checksum returns 404', async () => {
    const base = `${downloads}/tomcat/tomcat-11/`
    const url = `${base}v11.0.28/bin/apache-tomcat-11.0.28.zip`
    const read = readFrom({
      [base]: listing('v11.0.29/', 'v11.0.28/', 'v11.0.27/'),
      [`${url}.sha512`]: hash
    })
    expect(await findApacheBuild('tomcat', '11', { platform: 'win32', read })).toMatchObject({ url, version: '11.0.28' })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('ignores Ant source archives and checksum links when choosing a binary release', async () => {
    const base = `${downloads}/ant/binaries/`
    const url = `${base}apache-ant-1.10.18-bin.tar.gz`
    const read = readFrom({
      [base]: listing('apache-ant-1.10.20-src.tar.gz', 'apache-ant-1.10.19-bin.tar.gz.sha512',
        'apache-ant-1.10.19-bin.tar.bz2', 'apache-ant-1.10.18-bin.tar.gz', 'apache-ant-1.10.9-bin.zip'),
      [`${url}.sha512`]: hash
    })
    expect(await findApacheBuild('ant', '1.10', { platform: 'darwin', read })).toMatchObject({ archive: 'tar.gz', url })
  })

  it.each([null, 'a1'.repeat(20), `${hash} *other.zip`])('fails closed when Tomcat lacks a matching SHA-512 sidecar', async checksum => {
    const base = `${archive}/tomcat/tomcat-7/`
    const read = readFrom({ [base]: listing('v7.0.109/'), [`${base}v7.0.109/bin/apache-tomcat-7.0.109.zip.sha512`]: checksum })
    await expect(findApacheBuild('tomcat', '7', { platform: 'win32', read })).rejects.toThrow(/7\.0\.109의 SHA-512/)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('refuses to download Tomcat 6 before contacting the archive', async () => {
    const base = `${archive}/tomcat/tomcat-6/`
    const read = readFrom({ [base]: listing('v6.0.53/') })
    await expect(findApacheBuild('tomcat', '6', { platform: 'win32', read })).rejects.toThrow(/Tomcat 6 공식 배포본에 SHA-512/)
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects unsupported series, platform and tool without network requests', async () => {
    const read = vi.fn()
    const options = { platform: 'win32', read }
    expect(await findApacheBuild('tomcat', '10.0', options)).toBeNull()
    expect(await findApacheBuild('tomcat', '6/../../', options)).toBeNull()
    expect(await findApacheBuild('constructor', '6', options)).toBeNull()
    expect(await findApacheBuild('maven', '3.9', { ...options, platform: 'unsupported' })).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
})
