import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { createRemoteDocuments, MESSAGES } = require('./documents.js')
const { createBackupStore, backupTarget } = require('./backups.js')
const { createFakeSftp } = require('../mcp/fakeSftp.testhelper.js')

const OWNER = 7
const SERVER = { username: 'deploy', host: '10.0.0.5' }

let root
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-docs-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

function setup(tree, options = {}, { now } = {}) {
  const sftp = createFakeSftp({ '/etc': { type: 'dir' }, '/var': { type: 'dir' }, '/var/log': { type: 'dir' }, ...tree }, options)
  const store = createBackupStore({ root, ...(now ? { now } : {}) })
  let id = 0
  const docs = createRemoteDocuments({
    openSftp: async () => sftp,
    serverOf: () => SERVER,
    backups: { root, store },
    newId: () => `doc-${++id}`
  })
  const open = (remotePath, mode = 'edit') => {
    const { docId } = docs.register({ sessionId: 'tab-1', sessionName: 'dev', remotePath, mode })
    docs.attach(docId, OWNER)
    return docId
  }
  const backupDir = (remotePath) => backupTarget(root, { sessionName: 'dev', ...SERVER }, remotePath)
  return { sftp, docs, store, open, backupDir }
}

const file = (data) => ({ type: 'file', data })

describe('file window: edit and save', () => {
  it('opens text for editing and tells whether it can be written', async () => {
    const { docs, open } = setup({ '/etc/app.conf': file('a=1\n') })
    const docId = open('/etc/app.conf')
    const loaded = await docs.load(OWNER, docId)
    expect(loaded).toMatchObject({ kind: 'text', editable: true, content: 'a=1\n', canWrite: true, path: '/etc/app.conf' })
  })

  it('opens read-only when the file cannot be opened for writing', async () => {
    const denied = (target, flags) => { if (flags === 'r+') throw Object.assign(new Error('denied'), { code: 3 }) }
    const { docs, open } = setup({ '/etc/app.conf': file('a=1\n') }, { onBeforeOpen: denied })
    const docId = open('/etc/app.conf')
    expect((await docs.load(OWNER, docId)).canWrite).toBe(false)
    const { token } = docs.review(OWNER, docId, 'a=2\n')
    await expect(docs.save(OWNER, docId, 'a=2\n', token)).rejects.toMatchObject({ userMessage: MESSAGES.readOnly })
  })

  it('answers only the window the file was opened in', async () => {
    const { docs, open } = setup({ '/etc/app.conf': file('a=1\n') })
    const docId = open('/etc/app.conf')
    await expect(docs.load(OWNER + 1, docId)).rejects.toMatchObject({ userMessage: MESSAGES.gone })
    await expect(docs.load(OWNER, 'doc-unknown')).rejects.toMatchObject({ userMessage: MESSAGES.gone })
  })

  it('backs up the server content, then saves exactly the reviewed text', async () => {
    const { sftp, docs, store, open, backupDir } = setup({ '/etc/app.conf': file('a=1\n') })
    const docId = open('/etc/app.conf')
    await docs.load(OWNER, docId)
    const reviewed = docs.review(OWNER, docId, 'a=2\n')
    expect(reviewed.change).toMatchObject({ added: 1, removed: 1 })
    const result = await docs.save(OWNER, docId, 'a=2\n', reviewed.token)
    expect(result.ok).toBe(true)
    expect(sftp.text('/etc/app.conf')).toBe('a=2\n')
    const target = backupDir('/etc/app.conf')
    expect(await store.read(target, result.backupName)).toBe('a=1\n')
  })

  it('backs up the previous save on the next one', async () => {
    let tick = 0
    const now = () => new Date(2026, 10, 5, 15, 0, tick++)
    const { docs, store, open, backupDir } = setup({ '/etc/app.conf': file('v1\n') }, {}, { now })
    const docId = open('/etc/app.conf')
    await docs.load(OWNER, docId)
    for (const next of ['v2\n', 'v3\n']) {
      const { token } = docs.review(OWNER, docId, next)
      await docs.save(OWNER, docId, next, token)
    }
    const listed = await store.list(backupDir('/etc/app.conf'))
    expect(await Promise.all(listed.map(entry => store.read(backupDir('/etc/app.conf'), entry.name)))).toEqual(['v2\n', 'v1\n'])
  })

  it('refuses text that is not the reviewed text, or a save without a review', async () => {
    const { sftp, docs, open } = setup({ '/etc/app.conf': file('a=1\n') })
    const docId = open('/etc/app.conf')
    await docs.load(OWNER, docId)
    await expect(docs.save(OWNER, docId, 'a=2\n', 'token')).rejects.toMatchObject({ userMessage: MESSAGES.notReviewed })
    const { token } = docs.review(OWNER, docId, 'a=2\n')
    await expect(docs.save(OWNER, docId, 'a=3\n', token)).rejects.toMatchObject({ userMessage: MESSAGES.notReviewed })
    expect(sftp.text('/etc/app.conf')).toBe('a=1\n')
  })

  it('needs a new review after the file was read again', async () => {
    const { docs, open } = setup({ '/etc/app.conf': file('a=1\n') })
    const docId = open('/etc/app.conf')
    await docs.load(OWNER, docId)
    const { token } = docs.review(OWNER, docId, 'a=2\n')
    await docs.load(OWNER, docId)
    await expect(docs.save(OWNER, docId, 'a=2\n', token)).rejects.toMatchObject({ userMessage: MESSAGES.notReviewed })
  })

  it('does not overwrite a file that changed on the server, and drops the backup it made', async () => {
    const { sftp, docs, store, open, backupDir } = setup({ '/etc/app.conf': file('a=1\n') })
    const docId = open('/etc/app.conf')
    await docs.load(OWNER, docId)
    sftp.tree.set('/etc/app.conf', file('someone else\n'))
    const { token } = docs.review(OWNER, docId, 'a=2\n')
    const result = await docs.save(OWNER, docId, 'a=2\n', token)
    expect(result).toMatchObject({ ok: false, conflict: true })
    expect(sftp.text('/etc/app.conf')).toBe('someone else\n')
    expect(await store.list(backupDir('/etc/app.conf'))).toEqual([])
  })

  it('keeps older backups when a save is refused for a conflict', async () => {
    let tick = 0
    const now = () => new Date(2026, 10, 5, 15, 0, tick++)
    const sftp = createFakeSftp({ '/etc': { type: 'dir' }, '/etc/app.conf': file('v0\n') })
    const store = createBackupStore({ root, keep: 2, now })
    const docs = createRemoteDocuments({ openSftp: async () => sftp, serverOf: () => SERVER, backups: { root, store }, newId: () => 'doc-1' })
    const { docId } = docs.register({ sessionId: 'tab-1', sessionName: 'dev', remotePath: '/etc/app.conf', mode: 'edit' })
    docs.attach(docId, OWNER)
    await docs.load(OWNER, docId)
    for (const next of ['v1\n', 'v2\n']) {
      const { token } = docs.review(OWNER, docId, next)
      await docs.save(OWNER, docId, next, token)
    }
    const target = backupTarget(root, { sessionName: 'dev', ...SERVER }, '/etc/app.conf')
    const before = (await store.list(target)).map(entry => entry.name)
    for (let i = 0; i < 3; i++) {
      sftp.tree.set('/etc/app.conf', file(`other ${i}\n`))
      const { token } = docs.review(OWNER, docId, 'mine\n')
      expect((await docs.save(OWNER, docId, 'mine\n', token)).conflict).toBe(true)
    }
    expect((await store.list(target)).map(entry => entry.name)).toEqual(before)
  })

  it('accepts a review for one save attempt only', async () => {
    const { sftp, docs, open } = setup({ '/etc/app.conf': file('a=1\n') })
    const docId = open('/etc/app.conf')
    await docs.load(OWNER, docId)
    sftp.tree.set('/etc/app.conf', file('other\n'))
    const { token } = docs.review(OWNER, docId, 'a=2\n')
    expect((await docs.save(OWNER, docId, 'a=2\n', token)).conflict).toBe(true)
    await expect(docs.save(OWNER, docId, 'a=2\n', token)).rejects.toMatchObject({ userMessage: MESSAGES.notReviewed })
  })

  it('closes the channel only after a running save ended', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const { sftp, docs, open } = setup({ '/etc/app.conf': file('a=1\n') }, { beforeWrite: () => gate })
    const docId = open('/etc/app.conf')
    await docs.load(OWNER, docId)
    const { token } = docs.review(OWNER, docId, 'a=2\n')
    const saving = docs.save(OWNER, docId, 'a=2\n', token)
    await new Promise(resolve => setTimeout(resolve, 20))
    docs.close(docId)
    expect(sftp.isEnded()).toBe(false)
    release()
    await saving
    await new Promise(resolve => setImmediate(resolve))
    expect(sftp.text('/etc/app.conf')).toBe('a=2\n')
    expect(sftp.isEnded()).toBe(true)
  })

  it('opens at most 20 file windows', () => {
    const { docs } = setup({})
    for (let i = 0; i < 20; i++) docs.register({ sessionId: 'tab-1', sessionName: 'dev', remotePath: `/etc/f${i}`, mode: 'preview' })
    expect(() => docs.register({ sessionId: 'tab-1', sessionName: 'dev', remotePath: '/etc/more', mode: 'preview' })).toThrow(MESSAGES.tooMany)
  })

  it('does not save when the backup cannot be written', async () => {
    const { sftp, docs, open } = setup({ '/etc/app.conf': file('a=1\n') })
    // A file where the backup folder should be
    fs.writeFileSync(path.join(root, 'dev (deploy@10.0.0.5)'), 'x')
    const docId = open('/etc/app.conf')
    await docs.load(OWNER, docId)
    const { token } = docs.review(OWNER, docId, 'a=2\n')
    await expect(docs.save(OWNER, docId, 'a=2\n', token)).rejects.toMatchObject({ userMessage: MESSAGES.backupFailed })
    expect(sftp.text('/etc/app.conf')).toBe('a=1\n')
  })

  it('reports no change for the text that was opened', async () => {
    const { docs, open } = setup({ '/etc/app.conf': file('a=1\n') })
    const docId = open('/etc/app.conf')
    await docs.load(OWNER, docId)
    expect(docs.review(OWNER, docId, 'a=1\n')).toEqual({ unchanged: true })
  })

  it('reads a backup of this file only', async () => {
    const { docs, open } = setup({ '/etc/app.conf': file('a=1\n') })
    const docId = open('/etc/app.conf')
    await docs.load(OWNER, docId)
    const { token } = docs.review(OWNER, docId, 'a=2\n')
    const { backupName } = await docs.save(OWNER, docId, 'a=2\n', token)
    expect(await docs.readBackup(OWNER, docId, backupName)).toEqual({ content: 'a=1\n' })
    await expect(docs.readBackup(OWNER, docId, '../../secret.txt')).rejects.toMatchObject({ userMessage: MESSAGES.noBackup })
  })

  it('refuses system paths and binary files', async () => {
    const { docs, open } = setup({ '/proc': { type: 'dir' }, '/proc/cpuinfo': file('cpu'), '/etc/blob': file(Buffer.from([1, 0, 2])) })
    await expect(docs.load(OWNER, open('/proc/cpuinfo'))).rejects.toThrow()
    await expect(docs.load(OWNER, open('/etc/blob'))).rejects.toThrow()
  })

  it('opens one window per file and mode', () => {
    const { docs } = setup({})
    const first = docs.register({ sessionId: 'tab-1', sessionName: 'dev', remotePath: '/etc/a', mode: 'edit' })
    expect(docs.register({ sessionId: 'tab-1', sessionName: 'dev', remotePath: '/etc/a', mode: 'edit' })).toEqual({ docId: first.docId, existing: true })
    expect(docs.register({ sessionId: 'tab-1', sessionName: 'dev', remotePath: '/etc/a', mode: 'preview' }).existing).toBe(false)
  })
})

describe('file window: preview', () => {
  it('shows the end of a large log from a whole line', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const { sftp } = setup({ '/var/log/app.log': file(lines) })
    const read = require('./remoteRead.js')
    const preview = await read.readTextPreview(sftp, '/var/log/app.log', { wholeMaxBytes: 100, tailBytes: 50 })
    expect(preview.truncated).toBe(true)
    expect(preview.text.startsWith('line ')).toBe(true)
    expect(lines.endsWith(preview.text)).toBe(true)
    expect(preview.text.length).toBeLessThanOrEqual(50)
  })

  it('reads a whole small text file and an image', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])
    const { docs, open } = setup({ '/var/log/a.log': file('hello\n'), '/var/logo.png': file(png) })
    expect(await docs.load(OWNER, open('/var/log/a.log', 'preview'))).toMatchObject({ kind: 'text', editable: false, content: 'hello\n', truncated: false })
    const image = await docs.load(OWNER, open('/var/logo.png', 'preview'))
    expect(image).toMatchObject({ kind: 'image', mime: 'image/png', size: png.length })
    expect(Buffer.from(image.data).equals(png)).toBe(true)
  })
})

describe('file window: following a log', () => {
  /** Looks at the log the way the window does: naming the cursor of the answer it took in. */
  async function follower(docs, docId) {
    const loaded = await docs.load(OWNER, docId)
    let { generation, cursor } = loaded.follow
    return {
      loaded,
      look: async ({ takeIn = true } = {}) => {
        const answer = await docs.tail(OWNER, docId, { generation, cursor })
        if (takeIn && answer.cursor !== undefined) cursor = answer.cursor
        const { cursor: _ignored, ...rest } = answer
        return rest
      },
      generation: () => generation
    }
  }

  it('sends what was added after what the window shows', async () => {
    const { sftp, docs, open } = setup({ '/var/log/a.log': file('one\n') })
    const follow = await follower(docs, open('/var/log/a.log', 'tail'))
    expect(follow.loaded).toMatchObject({ kind: 'text', mode: 'tail', content: 'one\n' })
    expect(await follow.look()).toEqual({ status: 'same' })
    sftp.tree.set('/var/log/a.log', file('one\ntwo\n'))
    expect(await follow.look()).toEqual({ status: 'append', text: 'two\n' })
    sftp.tree.set('/var/log/a.log', file('one\ntwo\nthree\n'))
    expect(await follow.look()).toEqual({ status: 'append', text: 'three\n' })
  })

  it('sends the same lines again when the window dropped the answer (paused meanwhile)', async () => {
    const { sftp, docs, open } = setup({ '/var/log/a.log': file('one\n') })
    const follow = await follower(docs, open('/var/log/a.log', 'tail'))
    sftp.tree.set('/var/log/a.log', file('one\ntwo\n'))
    expect(await follow.look({ takeIn: false })).toEqual({ status: 'append', text: 'two\n' })
    sftp.tree.set('/var/log/a.log', file('one\ntwo\nthree\n'))
    expect(await follow.look()).toEqual({ status: 'append', text: 'two\nthree\n' })
  })

  it('answers looks from before a refresh with stale, and keeps the refreshed place', async () => {
    const { sftp, docs, open } = setup({ '/var/log/a.log': file('one\n') })
    const docId = open('/var/log/a.log', 'tail')
    const before = await follower(docs, docId)
    sftp.tree.set('/var/log/a.log', file('one\ntwo\n'))
    const after = await follower(docs, docId)
    expect(after.loaded.content).toBe('one\ntwo\n')
    expect(await before.look()).toEqual({ status: 'stale' })
    sftp.tree.set('/var/log/a.log', file('one\ntwo\nthree\n'))
    expect(await after.look()).toEqual({ status: 'append', text: 'three\n' })
  })

  it('follows a text preview too, but never an edit window or another window\'s file', async () => {
    const { docs, open } = setup({ '/var/log/a.log': file('one\n') })
    const previewId = open('/var/log/a.log', 'preview')
    const follow = await follower(docs, previewId)
    expect(await follow.look()).toEqual({ status: 'same' })
    await expect(docs.tail(OWNER + 1, previewId, {})).rejects.toMatchObject({ userMessage: MESSAGES.gone })
    const editId = open('/var/log/a.log', 'edit')
    await docs.load(OWNER, editId)
    await expect(docs.tail(OWNER, editId, {})).rejects.toMatchObject({ userMessage: MESSAGES.notFollowable })
  })

  it('runs one look at a time', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const { sftp, docs, open } = setup({ '/var/log/a.log': file('one\n') })
    const docId = open('/var/log/a.log', 'tail')
    const { follow } = await docs.load(OWNER, docId)
    const originalStat = sftp.stat
    sftp.stat = (target, cb) => { void gate.then(() => originalStat(target, cb)) }
    const first = docs.tail(OWNER, docId, follow)
    expect(await docs.tail(OWNER, docId, follow)).toEqual({ status: 'busy' })
    release()
    expect((await first).status).toBe('same')
  })

  it('gives up a look the server does not answer, and can look again', async () => {
    const sftp = createFakeSftp({ '/var': { type: 'dir' }, '/var/log': { type: 'dir' }, '/var/log/a.log': file('one\n') })
    const docs = createRemoteDocuments({ openSftp: async () => sftp, serverOf: () => SERVER, backups: { root, store: {} }, tailTimeoutMs: 30 })
    const { docId } = docs.register({ sessionId: 'tab-1', sessionName: 'dev', remotePath: '/var/log/a.log', mode: 'tail' })
    docs.attach(docId, OWNER)
    const { follow } = await docs.load(OWNER, docId)
    const originalStat = sftp.stat
    sftp.stat = () => {}
    await expect(docs.tail(OWNER, docId, follow)).rejects.toMatchObject({ userMessage: MESSAGES.slow })
    sftp.stat = originalStat
    expect((await docs.tail(OWNER, docId, follow)).status).toBe('same')
  })

  it('opens a followed log that holds NUL bytes, without them', async () => {
    const { docs, open } = setup({ '/var/log/a.log': file(Buffer.concat([Buffer.from('a\n'), Buffer.alloc(4), Buffer.from('b\n')])) })
    expect((await docs.load(OWNER, open('/var/log/a.log', 'tail'))).content).toBe('a\nb\n')
    // A plain preview still refuses it as binary
    const { MESSAGES: READ_MESSAGES } = require('./remoteRead.js')
    await expect(docs.load(OWNER, open('/var/log/a.log', 'preview'))).rejects.toMatchObject({ userMessage: READ_MESSAGES.notText })
  })
})

describe('file window: SFTP channel', () => {
  it('shares one channel among the windows of a tab and ends it after the last one closed', async () => {
    const sftp = createFakeSftp({ '/etc': { type: 'dir' }, '/etc/a': file('a\n'), '/etc/b': file('b\n') })
    let opened = 0
    const docs = createRemoteDocuments({ openSftp: async () => { opened++; return sftp }, serverOf: () => SERVER, backups: { root, store: {} } })
    const openDoc = (remotePath) => {
      const { docId } = docs.register({ sessionId: 'tab-1', sessionName: 'dev', remotePath, mode: 'preview' })
      docs.attach(docId, OWNER)
      return docId
    }
    const a = openDoc('/etc/a')
    const b = openDoc('/etc/b')
    await Promise.all([docs.load(OWNER, a), docs.load(OWNER, b)])
    expect(opened).toBe(1)
    docs.close(a)
    expect(sftp.isEnded()).toBe(false)
    docs.close(b)
    expect(sftp.isEnded()).toBe(true)
  })

  it('tells a refused channel apart from a missing connection', async () => {
    const make = (error) => {
      const docs = createRemoteDocuments({ openSftp: async () => { throw error }, serverOf: () => SERVER, backups: { root, store: {} } })
      const { docId } = docs.register({ sessionId: 'tab-1', sessionName: 'dev', remotePath: '/etc/a', mode: 'preview' })
      docs.attach(docId, OWNER)
      return docs.load(OWNER, docId)
    }
    await expect(make(Object.assign(new Error('no connection'), { code: 'NO_CONNECTION' }))).rejects.toMatchObject({ userMessage: MESSAGES.noConnection })
    await expect(make(new Error('(SSH) Channel open failure: open failed'))).rejects.toMatchObject({ userMessage: MESSAGES.channelRefused })
  })
})

describe('file window: backups left on the server', () => {
  const tree = {
    '/srv': { type: 'dir' },
    '/srv/compose.yaml': file('now\n'),
    '/srv/compose.yaml.bak_20261020_1516': file('old\r\n'),
    '/srv/compose.yaml.orig': file('orig\n'),
    '/srv/secret.txt': file('do not read\n')
  }

  it('lists backups beside the file without their paths', async () => {
    const { docs, open } = setup(tree)
    const docId = open('/srv/compose.yaml')
    await docs.load(OWNER, docId)
    const { backups } = await docs.listServerBackups(OWNER, docId)
    expect(backups.map(b => b.name)).toEqual(['compose.yaml.bak_20261020_1516', 'compose.yaml.orig'])
    expect(backups[0]).not.toHaveProperty('path')
    expect(backups[0]).toMatchObject({ size: 5, timeFrom: 'name' })
  })

  it('reads a listed backup as it is', async () => {
    const { docs, open } = setup(tree)
    const docId = open('/srv/compose.yaml')
    await docs.load(OWNER, docId)
    await docs.listServerBackups(OWNER, docId)
    expect(await docs.readServerBackup(OWNER, docId, 'compose.yaml.bak_20261020_1516')).toEqual({ content: 'old\r\n' })
  })

  it('refuses names that were not in the last list', async () => {
    const { docs, open } = setup(tree)
    const docId = open('/srv/compose.yaml')
    await docs.load(OWNER, docId)
    await expect(docs.readServerBackup(OWNER, docId, 'compose.yaml.orig')).rejects.toMatchObject({ userMessage: MESSAGES.noBackup })
    await docs.listServerBackups(OWNER, docId)
    for (const name of ['secret.txt', '../srv/secret.txt', '/srv/secret.txt', 'compose.yaml']) {
      await expect(docs.readServerBackup(OWNER, docId, name)).rejects.toMatchObject({ userMessage: MESSAGES.noBackup })
    }
  })

  it('answers only the window the file was opened in', async () => {
    const { docs, open } = setup(tree)
    const docId = open('/srv/compose.yaml')
    await docs.load(OWNER, docId)
    await docs.listServerBackups(OWNER, docId)
    await expect(docs.listServerBackups(OWNER + 1, docId)).rejects.toMatchObject({ userMessage: MESSAGES.gone })
    await expect(docs.readServerBackup(OWNER + 1, docId, 'compose.yaml.orig')).rejects.toMatchObject({ userMessage: MESSAGES.gone })
  })

  it('refuses a backup that became a link after it was listed', async () => {
    const { docs, open, sftp } = setup(tree)
    const docId = open('/srv/compose.yaml')
    await docs.load(OWNER, docId)
    await docs.listServerBackups(OWNER, docId)
    sftp.tree.set('/srv/compose.yaml.orig', { type: 'link', target: '/srv/secret.txt' })
    await expect(docs.readServerBackup(OWNER, docId, 'compose.yaml.orig')).rejects.toMatchObject({ userMessage: MESSAGES.noBackup })
  })

  it('refuses a backup larger than the editor takes', async () => {
    const big = { ...tree, '/srv/compose.yaml.bak': file('x'.repeat(5 * 1024 * 1024 + 1)) }
    const { docs, open } = setup(big)
    const docId = open('/srv/compose.yaml')
    await docs.load(OWNER, docId)
    await docs.listServerBackups(OWNER, docId)
    await expect(docs.readServerBackup(OWNER, docId, 'compose.yaml.bak')).rejects.toMatchObject({ userMessage: MESSAGES.backupTooLarge })
  })

  it('gives an empty list when the folder cannot be listed', async () => {
    const { docs, open, sftp } = setup(tree)
    const docId = open('/srv/compose.yaml')
    await docs.load(OWNER, docId)
    sftp.readdir = (target, cb) => setImmediate(() => cb(Object.assign(new Error('denied'), { code: 3 })))
    expect(await docs.listServerBackups(OWNER, docId)).toEqual({ backups: [] })
  })
})
