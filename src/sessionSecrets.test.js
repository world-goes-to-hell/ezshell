import { describe, it, expect } from 'vitest'
import { sealSession, prepareSessionSaves, openSession, needsResealing, resealAll } from './sessionSecrets.js'
import cryptoUtil from './crypto.js'

const PASS = 'master-pass'
const session = {
  id: 's1', name: '운영 DB 서버', host: '10.0.0.5', port: 22, username: 'deploy', authType: 'password',
  password: 'ssh-secret', suRoot: true, suPassword: 'root-secret',
  useJumpHost: true, jumpHost: 'bastion', jumpPassword: 'jump-secret', jumpPassphrase: 'jump-phrase', jumpPrivateKeyPath: 'C:\\keys\\jump',
  dbConnections: [{ id: 'a1', engine: 'mysql', host: '127.0.0.1', port: 3306, user: 'reader', password: 'db-secret' }],
  dbAliases: { 'mysql:127.0.0.1:3306': '조회 DB' }
}
const SECRETS = ['ssh-secret', 'root-secret', 'jump-secret', 'jump-phrase', 'C:\\\\keys\\\\jump', 'db-secret', 'reader']

describe('sealSession', () => {
  it('writes no secret in plain text', () => {
    const text = JSON.stringify(sealSession(session, PASS))
    for (const secret of SECRETS) expect(text).not.toContain(secret)
    // What the list needs stays readable
    expect(text).toContain('운영 DB 서버')
    expect(text).toContain('조회 DB')
  })

  it('opens back to the same session', () => {
    expect(openSession(sealSession(session, PASS), PASS)).toEqual(session)
  })

  it('drops the app\'s own marks', () => {
    const sealed = sealSession({ ...session, needsMigration: true, decryptionFailed: true }, PASS)
    expect(sealed).not.toHaveProperty('needsMigration')
    expect(sealed).not.toHaveProperty('decryptionFailed')
  })
})

describe('preparing session saves', () => {
  it('reuses the encrypted blob for appearance and connection metadata edits', () => {
    const stored = sealSession(session, PASS)
    const edited = { ...session, name: '새 이름', port: 2222, backgroundColor: '#ef4444', mcpEnabled: true }
    const [record] = prepareSessionSaves([edited], PASS, [{ stored, opened: openSession(stored, PASS) }])

    expect(record.stored.encrypted).toBe(stored.encrypted)
    expect(record.opened).toEqual(edited)
    expect(openSession(record.stored, PASS)).toEqual(edited)
  })

  it('reseals only changed secret data and preserves an unreadable blob on a rename', () => {
    const [original, other] = prepareSessionSaves([session, { ...session, id: 's2' }], PASS)
    const unreadable = { id: 's3', name: '읽을 수 없는 세션', ...sealSession({ id: 's3' }, 'other-pass') }
    const openedUnreadable = openSession(unreadable, PASS)
    const changed = { ...session, dbConnections: [{ ...session.dbConnections[0], password: 'new-secret' }] }
    const [updated, unchanged, renamed] = prepareSessionSaves([changed, other.opened, { ...openedUnreadable, name: '변경' }], PASS, [
      original, other, { stored: unreadable, opened: openedUnreadable }
    ])

    expect(updated.stored.encrypted).not.toEqual(original.stored.encrypted)
    expect(openSession(updated.stored, PASS)).toEqual(changed)
    expect(unchanged.stored.encrypted).toBe(other.stored.encrypted)
    expect(renamed.stored.encrypted).toBe(unreadable.encrypted)
    expect(renamed.opened.decryptionFailed).toBe(true)
  })
})

describe('a file written by older versions', () => {
  // Only password, passphrase and privateKeyPath were in the blob, with null for empty ones
  const old = {
    id: 's1', name: '운영 DB 서버', host: '10.0.0.5', username: 'deploy', suPassword: 'root-secret', jumpPassword: '',
    dbConnections: [{ id: 'a1', engine: 'mysql', host: '127.0.0.1', port: 3306, user: 'reader', password: 'db-secret' }],
    encrypted: cryptoUtil.encrypt(JSON.stringify({ password: 'ssh-secret', passphrase: null, privateKeyPath: null }), PASS),
    encryptedVersion: 1
  }

  it('still opens, with the secrets that were outside the blob', () => {
    const opened = openSession(old, PASS)
    expect(opened.password).toBe('ssh-secret')
    expect(opened.suPassword).toBe('root-secret')
    expect(opened.dbConnections[0].password).toBe('db-secret')
    expect(opened.passphrase).toBeNull()
  })

  it('is told to be written again, and then holds nothing in plain text', () => {
    expect(needsResealing(old)).toBe(true)
    const [resealed] = resealAll([old], PASS)
    const text = JSON.stringify(resealed)
    for (const secret of ['ssh-secret', 'root-secret', 'db-secret', 'reader']) expect(text).not.toContain(secret)
    expect(needsResealing(resealed)).toBe(false)
    expect(openSession(resealed, PASS).dbConnections[0].password).toBe('db-secret')
  })

  it('leaves a session that does not open with this password as it was', () => {
    const other = { ...old, id: 's2', encrypted: cryptoUtil.encrypt('{}', 'other-pass') }
    const result = resealAll([old, other], PASS)
    expect(result[1]).toBe(other)
  })

  it('writes nothing when the file is already sealed', () => {
    expect(resealAll([sealSession(session, PASS)], PASS)).toBeNull()
    expect(resealAll([], PASS)).toBeNull()
  })

  it('treats a session never encrypted as one to seal', () => {
    const plain = { id: 's3', name: 'x', host: 'h', username: 'u', password: 'plain-secret' }
    expect(openSession(plain, PASS)).toMatchObject({ needsMigration: true, password: 'plain-secret' })
    const [sealed] = resealAll([plain], PASS)
    expect(JSON.stringify(sealed)).not.toContain('plain-secret')
    expect(openSession(sealed, PASS).password).toBe('plain-secret')
  })
})
