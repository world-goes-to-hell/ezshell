import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import checkModule from './hostKeyCheck.js'
import storeModule from './hostKeyStore.js'
import helper from './hostKeys.testhelper.js'

const { withHostKeyCheck, HostKeyError, hostKeyMessage } = checkModule
const { createHostKeyStore } = storeModule
const { hostKey } = helper

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-hostcheck-'))
  return createHostKeyStore({ filePath: path.join(dir, 'known-hosts.json') })
}

/**
 * Fake connection attempt: offers each server's key to the verifier in order, like ssh2 does during the
 * handshake. `servers(attemptNumber)` returns [{ host, port, key }]; a refused key fails the attempt.
 */
function fakeAttempt(servers) {
  let count = 0
  const attempt = vi.fn(async (verifierFor) => {
    count += 1
    for (const { host, port, key } of servers(count)) {
      if (!verifierFor(host, port)(key)) throw new Error('Host denied (verification failed)')
    }
    return 'connected'
  })
  return attempt
}

const one = (key) => () => [{ host: 'dev.example', port: 22, key }]

describe('withHostKeyCheck', () => {
  it('connects without asking when the key is saved', async () => {
    const store = tempStore()
    store.trust('dev.example', 22, hostKey())
    const prompt = vi.fn()
    await expect(withHostKeyCheck({ store, prompt }, fakeAttempt(one(hostKey())))).resolves.toBe('connected')
    expect(prompt).not.toHaveBeenCalled()
  })

  it('refuses an unknown server when nobody can be asked, and saves nothing', async () => {
    const store = tempStore()
    const err = await withHostKeyCheck({ store }, fakeAttempt(one(hostKey()))).catch(e => e)
    expect(err).toBeInstanceOf(HostKeyError)
    expect(err.reason).toBe('unknown')
    expect(store.check('dev.example', 22, hostKey()).status).toBe('unknown')
  })

  it('refuses a changed key when nobody can be asked', async () => {
    const store = tempStore()
    store.trust('dev.example', 22, hostKey('ssh-ed25519', 1))
    const err = await withHostKeyCheck({ store }, fakeAttempt(one(hostKey('ssh-ed25519', 2)))).catch(e => e)
    expect(err.reason).toBe('changed')
    expect(store.check('dev.example', 22, hostKey('ssh-ed25519', 1)).status).toBe('trusted')
  })

  it('asks about an unknown server, saves the key when trusted and connects again', async () => {
    const store = tempStore()
    const prompt = vi.fn(async () => 'trust')
    const attempt = fakeAttempt(one(hostKey()))
    await expect(withHostKeyCheck({ store, prompt }, attempt)).resolves.toBe('connected')
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ status: 'unknown', host: 'dev.example', port: 22, keyType: 'ssh-ed25519' }))
    expect(store.check('dev.example', 22, hostKey()).status).toBe('trusted')
  })

  it('never hands the raw key to the prompt', async () => {
    const store = tempStore()
    const prompt = vi.fn(async () => 'reject')
    await withHostKeyCheck({ store, prompt }, fakeAttempt(one(hostKey()))).catch(() => {})
    expect(Object.keys(prompt.mock.calls[0][0]).sort()).toEqual(['fingerprint', 'host', 'keyType', 'port', 'status'])
  })

  it('shows the saved fingerprint when the key changed', async () => {
    const store = tempStore()
    store.trust('dev.example', 22, hostKey('ssh-ed25519', 1))
    const prompt = vi.fn(async () => 'trust')
    await withHostKeyCheck({ store, prompt }, fakeAttempt(one(hostKey('ssh-ed25519', 2))))
    expect(prompt.mock.calls[0][0]).toMatchObject({ status: 'changed', previous: { keyType: 'ssh-ed25519' } })
    expect(store.check('dev.example', 22, hostKey('ssh-ed25519', 2)).status).toBe('trusted')
  })

  it('does not save the key and fails when the user declines', async () => {
    const store = tempStore()
    const attempt = fakeAttempt(one(hostKey()))
    const err = await withHostKeyCheck({ store, prompt: async () => 'reject' }, attempt).catch(e => e)
    expect(err.reason).toBe('rejected')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(store.check('dev.example', 22, hostKey()).status).toBe('unknown')
  })

  it('treats a failed prompt as a refusal', async () => {
    const store = tempStore()
    const err = await withHostKeyCheck({ store, prompt: async () => { throw new Error('no window') } }, fakeAttempt(one(hostKey()))).catch(e => e)
    expect(err.reason).toBe('rejected')
    expect(store.check('dev.example', 22, hostKey()).status).toBe('unknown')
  })

  it('does not connect when the trusted key cannot be saved', async () => {
    const store = tempStore()
    const failing = { check: store.check, trust: () => { throw new Error('disk full') } }
    const attempt = fakeAttempt(one(hostKey()))
    const err = await withHostKeyCheck({ store: failing, prompt: async () => 'trust' }, attempt).catch(e => e)
    expect(err).toBeInstanceOf(HostKeyError)
    expect(err.reason).toBe('unsaved')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(hostKeyMessage(err).error).toContain('저장하지 못해')
  })

  it('asks again when the server shows yet another key on the next attempt, up to the limit', async () => {
    const store = tempStore()
    const prompt = vi.fn(async () => 'trust')
    const attempt = fakeAttempt((n) => [{ host: 'dev.example', port: 22, key: hostKey('ssh-ed25519', n) }])
    const err = await withHostKeyCheck({ store, prompt, maxPrompts: 3 }, attempt).catch(e => e)
    expect(err).toBeInstanceOf(HostKeyError)
    expect(prompt).toHaveBeenCalledTimes(3)
    expect(prompt.mock.calls[1][0].status).toBe('changed')
  })

  it('asks for the jump host and then for the target', async () => {
    const store = tempStore()
    const prompt = vi.fn(async () => 'trust')
    const attempt = fakeAttempt(() => [
      { host: 'bastion', port: 2222, key: hostKey('ssh-ed25519', 1) },
      { host: 'dev.example', port: 22, key: hostKey('ssh-ed25519', 2) }
    ])
    await expect(withHostKeyCheck({ store, prompt }, attempt)).resolves.toBe('connected')
    expect(prompt.mock.calls.map(([info]) => info.host)).toEqual(['bastion', 'dev.example'])
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('passes other connection errors through untouched', async () => {
    const store = tempStore()
    store.trust('dev.example', 22, hostKey())
    const failure = new Error('All configured authentication methods failed')
    const prompt = vi.fn()
    const err = await withHostKeyCheck({ store, prompt }, async (verifierFor) => {
      verifierFor('dev.example', 22)(hostKey())
      throw failure
    }).catch(e => e)
    expect(err).toBe(failure)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('reports a refused key even when the attempt resolves instead of throwing', async () => {
    const store = tempStore()
    const err = await withHostKeyCheck({ store }, async (verifierFor) => {
      verifierFor('dev.example', 22)(hostKey())
      return { success: false }
    }).catch(e => e)
    expect(err.reason).toBe('unknown')
  })
})

describe('hostKeyMessage', () => {
  it('tells MCP users how to confirm an unknown server', () => {
    const err = new HostKeyError('unknown', { host: 'dev.example', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:x' })
    expect(hostKeyMessage(err).error).toContain('호스트 키')
    expect(hostKeyMessage(err).hint).toContain('접속')
  })

  it('names the server by its address in the app, or by what the caller says', () => {
    const err = new HostKeyError('changed', { host: 'dev.example', port: 2201, keyType: 'ssh-ed25519', fingerprint: 'SHA256:x' })
    expect(hostKeyMessage(err).error).toContain('dev.example:2201')
    const told = hostKeyMessage(err, { subject: '이 세션의 서버' })
    expect(told.error).toContain('이 세션의 서버의 호스트 키')
    expect(`${told.error} ${told.hint}`).not.toContain('dev.example')
  })

  it('warns about a changed key', () => {
    const err = new HostKeyError('changed', { host: 'dev.example', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:x' })
    expect(hostKeyMessage(err).error).toContain('다릅니다')
  })
})
