import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { readFileZillaText, parseXml } = require('./filezilla.js')

const server = ({ host = 'db.example.com', port = 22, protocol = 1, user = 'deploy', logon = 1, name = '운영 DB', pass = '', key = '' } = {}) => `
    <Server>
      <Host>${host}</Host>
      <Port>${port}</Port>
      <Protocol>${protocol}</Protocol>
      <Type>0</Type>
      <User>${user}</User>
      ${pass ? `<Pass encoding="base64">${pass}</Pass>` : ''}
      <Logontype>${logon}</Logontype>
      ${key ? `<Keyfile>${key}</Keyfile>` : ''}
      <Name>${name}</Name>
    </Server>`

const siteManager = body => `<?xml version="1.0" encoding="UTF-8"?>
<FileZilla3 version="3.69.1" platform="windows">
  <Servers>${body}
  </Servers>
</FileZilla3>`

describe('FileZilla site manager', () => {
  it('reads SFTP sites with their folders, keys and whether a password was saved', () => {
    const xml = siteManager(`
    <Folder expanded="1">고객사 &amp; 운영
      ${server({ pass: 'c2VjcmV0' })}
      <Folder expanded="0">웹
        ${server({ host: 'web.example.com', port: 2222, logon: 5, key: 'C:\\keys\\web.ppk', name: 'web &lt;1&gt;' })}
      </Folder>
    </Folder>
    ${server({ host: '10.0.0.9', user: 'root', logon: 2, name: '' })}`)
    const result = readFileZillaText(xml)
    expect(result.source).toBe('filezilla')
    expect(result.folders.map(f => f.name)).toEqual(['고객사 & 운영', '웹'])
    expect(result.sessions).toMatchObject([
      { name: '운영 DB', host: 'db.example.com', port: 22, username: 'deploy', authType: 'password', hasSavedPassword: true, folderId: 'f1' },
      { name: 'web <1>', host: 'web.example.com', port: 2222, authType: 'privateKey', privateKeyPath: 'C:\\keys\\web.ppk', folderId: 'f2' },
      { name: '10.0.0.9', host: '10.0.0.9', username: 'root', hasSavedPassword: false, folderId: null }
    ])
    // The password itself is never carried
    expect(JSON.stringify(result)).not.toContain('c2VjcmV0')
  })

  it('leaves FTP sites out and counts them', () => {
    const result = readFileZillaText(siteManager(server({ protocol: 0 }) + server({ protocol: 4 }) + server()))
    expect(result.sessions).toHaveLength(1)
    expect(result.skipped).toEqual({ 'FTP 사이트': 1, 'FTPS 사이트': 1 })
  })

  it('reads an exported file the same way, and refuses what is not a FileZilla file', () => {
    expect(readFileZillaText(siteManager(server())).sessions).toHaveLength(1)
    expect(() => readFileZillaText('<?xml version="1.0"?><other/>')).toThrow('FileZilla')
    expect(() => readFileZillaText('<FileZilla3><Servers><Server>')).toThrow('FileZilla')
  })

  it('does not expand declared entities (a DOCTYPE is refused)', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><FileZilla3><Servers></Servers></FileZilla3>'
    expect(() => readFileZillaText(xml)).toThrow('FileZilla')
    expect(() => parseXml(xml)).toThrow()
  })

  it('reads character references and keeps a stray "&" as text', () => {
    const root = parseXml('<a x="1 &quot;2&quot;">&#54620;&#xAE00; &amp; R&D</a>')
    expect(root.attrs.x).toBe('1 "2"')
    expect(root.text).toBe('한글 & R&D')
  })
})
