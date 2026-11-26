import { describe, expect, it, vi } from 'vitest'
import { findGradleBuild, findNodeBuild } from './gradleNodeProviders.js'

const hash = 'a9'.repeat(32)
const gradleVersion = '9.9.2'
const gradleFilename = `gradle-${gradleVersion}-bin.zip`
const gradleUrl = `https://services.gradle.org/distributions/${gradleFilename}`
const gradle = { version: gradleVersion, downloadUrl: gradleUrl, checksumUrl: `${gradleUrl}.sha256` }
const nodeFiles = ['win-x64-zip', 'win-arm64-zip', 'osx-arm64-tar', 'linux-x64']
const node = [
  { version: 'v26.9.0', lts: 'Lithium', files: nodeFiles },
  { version: 'v27.0.0', lts: false, files: nodeFiles },
  { version: 'v26.13.1', lts: 'Lithium', files: nodeFiles }
]

describe('Gradle official binary distribution', () => {
  it('uses the stable release manifest and the matching binary SHA-256 sidecar', async () => {
    const loadJson = vi.fn(async () => gradle)
    const loadText = vi.fn(async () => `${hash.toUpperCase()} *${gradleFilename}\r\n`)
    const signal = new AbortController().signal
    expect(await findGradleBuild({ loadJson, loadText, signal })).toMatchObject({
      tool: 'gradle', series: 'current', version: gradleVersion, archive: 'zip', url: gradleUrl, sha256: hash
    })
    expect(loadJson).toHaveBeenCalledWith('https://services.gradle.org/versions/current', expect.objectContaining({ signal }))
    expect(loadText).toHaveBeenCalledWith(gradle.checksumUrl, expect.objectContaining({ signal, maxBytes: 4096 }))
  })

  it('reads the official bare digest and rejects an unexpected archive name', async () => {
    const loadJson = async () => gradle
    expect(await findGradleBuild({ loadJson, loadText: async () => hash })).toMatchObject({ sha256: hash })
    await expect(findGradleBuild({ loadJson, loadText: async () => `${hash}  gradle-9.9.2-all.zip` })).rejects.toThrow(/SHA-256/)
    await expect(findGradleBuild({ loadJson, loadText: async () => null })).rejects.toThrow(/SHA-256/)
  })

  it.each([
    { ...gradle, broken: true },
    { ...gradle, version: '10.0.0-rc-1' },
    { ...gradle, downloadUrl: 'https://services.gradle.org.invalid/gradle-9.9.2-bin.zip' },
    { ...gradle, checksumUrl: `${gradleUrl}.sha256?override=1` },
    { ...gradle, downloadUrl: gradleUrl.replace('-bin', '-all') }
  ])('avoids a checksum request for unsupported release metadata', async release => {
    const loadText = vi.fn()
    expect(await findGradleBuild({ loadJson: async () => release, loadText })).toBeNull()
    expect(loadText).not.toHaveBeenCalled()
  })
})

describe('Node.js official LTS archive', () => {
  it.each([
    ['win32', 'x64', 'win-x64.zip', 'zip'],
    ['win32', 'arm64', 'win-arm64.zip', 'zip'],
    ['darwin', 'arm64', 'darwin-arm64.tar.gz', 'tar.gz'],
    ['linux', 'x64', 'linux-x64.tar.gz', 'tar.gz']
  ])('uses the latest LTS file and its exact hash on %s %s', async (platform, arch, name, archive) => {
    const filename = `node-v26.13.1-${name}`
    const loadJson = vi.fn(async () => node)
    const loadText = vi.fn(async () => `${'0'.repeat(64)}  unrelated.tar.gz\r\n${hash}  ${filename}\r\n`)
    expect(await findNodeBuild({ platform, arch, loadJson, loadText })).toMatchObject({
      tool: 'node', series: 'lts', version: '26.13.1', arch, archive, sha256: hash,
      url: `https://nodejs.org/dist/v26.13.1/${filename}`
    })
    expect(loadJson).toHaveBeenCalledWith('https://nodejs.org/dist/index.json', expect.anything())
    expect(loadText).toHaveBeenCalledWith('https://nodejs.org/dist/v26.13.1/SHASUMS256.txt', expect.objectContaining({ maxBytes: 65536 }))
  })

  it('does not fall back to an old LTS tag when the current LTS lacks a binary', async () => {
    const loadText = vi.fn()
    const loadJson = async () => [{ version: 'v18.0.0', files: ['win-x86-zip'], lts: 'Older' }, ...node]
    expect(await findNodeBuild({ platform: 'win32', arch: 'ia32', loadJson, loadText })).toBeNull()
    expect(loadText).not.toHaveBeenCalled()
  })

  it('fails closed when the checksum is missing, malformed or duplicated', async () => {
    const matched = `${hash}  node-v26.13.1-win-x64.zip`
    for (const checksums of [null, `invalid  node-v26.13.1-win-x64.zip`, `${matched}\n${matched}`]) {
      await expect(findNodeBuild({ platform: 'win32', arch: 'x64', loadJson: async () => node, loadText: async () => checksums }))
        .rejects.toThrow(/SHA-256/)
    }
  })
})
