// Secrets of saved sessions are kept encrypted in sessions.json (src/sessionSecrets.js). Older
// versions wrote the root switch password, the jump host's password and the saved database accounts
// in plain text: such a file still opens, and right after unlocking it is written again with every
// secret encrypted. Saving afterwards keeps it that way. Uses the test profile only.
const fs = require('fs')
const path = require('path')
const { sleep, createChecks, connect, unlock } = require('../support/driver')
const cryptoUtil = require('../../src/crypto.js')
const { check, finish } = createChecks()

const PASSWORD = 'test-pass-1234' // what driver.unlock types
const SECRETS = ['ssh-secret', 'root-secret', 'jump-secret', 'db-secret']

;(async () => {
  const driver = await connect()
  const { js, send } = driver
  const file = path.join(process.env.E2E_PROFILE, 'sessions.json')
  const plainSecretsIn = () => SECRETS.filter(secret => fs.readFileSync(file, 'utf8').includes(secret))

  await unlock(driver)

  // A file as versions before 2026-11-18 wrote it: only password/passphrase/privateKeyPath encrypted
  fs.writeFileSync(file, JSON.stringify([{
    id: 'old-1', name: '옛 형식 세션', host: '10.0.0.5', port: 22, username: 'deploy', authType: 'password', icon: 'server',
    suRoot: true, suPassword: 'root-secret', useJumpHost: true, jumpHost: 'bastion', jumpPassword: 'jump-secret',
    dbConnections: [{ id: 'acc-1', engine: 'mysql', host: '127.0.0.1', port: 3306, user: 'reader', password: 'db-secret' }],
    encrypted: cryptoUtil.encrypt(JSON.stringify({ password: 'ssh-secret', passphrase: null, privateKeyPath: null }), PASSWORD),
    encryptedVersion: 1
  }], null, 2))
  check('the old file has secrets in plain text', plainSecretsIn().length === 3, JSON.stringify(plainSecretsIn()))

  // As at the next start: the window comes back locked
  await send('Page.reload')
  await sleep(1500)
  await unlock(driver)
  await sleep(800)
  check('after unlocking, no secret is left in plain text', plainSecretsIn().length === 0, JSON.stringify(plainSecretsIn()))
  check('the session is still in the list', await js(`[...document.querySelectorAll('.session-item, [class*="session"]')].some(el => el.textContent.includes('옛 형식 세션'))`))
  const loaded = await js(`window.electronAPI.loadSessions().then(r => { const s = r.sessions.find(x => x.id === 'old-1'); return s && { password: s.password, su: s.suPassword, jump: s.jumpPassword, db: s.dbConnections?.[0]?.password, failed: !!s.decryptionFailed } })`)
  check('and every secret reads back the same', JSON.stringify(loaded) === JSON.stringify({ password: 'ssh-secret', su: 'root-secret', jump: 'jump-secret', db: 'db-secret', failed: false }), JSON.stringify(loaded))

  // Saving from the app keeps them encrypted
  const sessions = await js(`window.electronAPI.loadSessions().then(r => r.sessions)`)
  const saved = await js(`window.electronAPI.saveSessions(${JSON.stringify(sessions.map(s => ({ ...s, name: s.name + ' (저장)' })))})`)
  check('saving again works', saved?.success === true, JSON.stringify(saved))
  check('and writes no secret in plain text', plainSecretsIn().length === 0, JSON.stringify(plainSecretsIn()))
  const after = await js(`window.electronAPI.loadSessions().then(r => r.sessions[0])`)
  check('the saved session reads back with its database account', after?.name === '옛 형식 세션 (저장)' && after?.dbConnections?.[0]?.password === 'db-secret', JSON.stringify({ name: after?.name }))

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
