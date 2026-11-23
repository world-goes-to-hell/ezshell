import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentMessages } from './agentMessages.js'
import { rpc } from './agentMessageCli.js'
import { createAgentRoleStore, roleSessionKey } from './agentRoleStore.js'

const session = 'c52f8001-53d1-43ea-8a89-7598f8baaf6c'
const anotherSession = 'e52f8001-53d1-43ea-8a89-7598f8baaf6c'
const day = 24 * 60 * 60 * 1000
const now = 1_800_000_000_000
let directory
let file
let messages
let locked

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-roles-'))
  file = path.join(directory, 'agent-roles.json')
  locked = false
})

afterEach(() => {
  messages?.stop()
  messages = undefined
  fs.rmSync(directory, { recursive: true, force: true })
})

async function restart() {
  messages?.stop()
  messages = createAgentMessages({ roleFile: file, notify: () => {}, isLocked: () => locked, home: directory })
  await messages.ready()
}

function register(kind, shellId, resume) {
  const { env, finish } = messages.register(kind, shellId, directory, {}, resume)
  return {
    id: env.EZSHELL_AGENT_ID,
    finish: () => finish(0),
    setRole: role => rpc({ method: 'set-role', role }, { pipe: env.EZSHELL_AGENT_PIPE, token: env.EZSHELL_AGENT_TOKEN })
  }
}

const getRole = id => messages.snapshot().agents.find(agent => agent.id === id)
const readFile = () => JSON.parse(fs.readFileSync(file, 'utf8'))

describe('agent roles saved by conversation', () => {
  it('restores both choices on restart and keeps different conversations and providers separate', async () => {
    await restart()
    const first = register('claude', 'local:1')
    await first.setRole('리뷰')
    messages.setUserRole(first.id, '구현')
    expect(fs.existsSync(file)).toBe(false)
    messages.setVerifiedSession(first.id, session.toUpperCase())
    expect(readFile()).toEqual({ [`claude:${session}`]: { agent: '리뷰', user: '구현', usedAt: expect.any(Number) } })

    await restart()
    const reused = register('claude', 'local:2', anotherSession)
    expect(reused.id).toBe(first.id)
    expect(getRole(reused.id)).toMatchObject({ role: null, roleSource: null })
    const codex = register('codex', 'local:3')
    messages.setVerifiedSession(codex.id, session)
    expect(getRole(codex.id)).toMatchObject({ role: null, roleSource: null })

    const resumed = register('claude', 'local:4', session)
    expect(getRole(resumed.id)).toMatchObject({ role: '구현', roleSource: 'user' })
    messages.registerLocalClaude({ cwd: directory, startedAt: Date.now(), sessionId: session }, () => ({ shellId: 'local:5' }))
    const external = messages.snapshot().agents.find(agent => agent.shellId === 'local:5')
    expect(external).toMatchObject({ role: null, roleSource: null })
    expect(messages.setUserRole(resumed.id, '')).toMatchObject({ role: '리뷰', roleSource: 'agent' })
    messages.setVerifiedSession(reused.id, session)
    expect(getRole(reused.id)).toMatchObject({ role: null, roleSource: null })
    locked = true
    expect(() => messages.setUserRole(resumed.id, '잠겼을 때 변경')).toThrow(/잠금/)
    expect(await resumed.setRole('잠겼을 때 변경')).toMatchObject({ success: false })
    expect(readFile()[`claude:${session}`]).toMatchObject({ agent: '리뷰' })
    expect(readFile()[`claude:${session}`]).not.toHaveProperty('user')
    locked = false
    resumed.finish()
    messages.setVerifiedSession(external.id, session)
    expect(getRole(external.id)).toMatchObject({ role: '리뷰', roleSource: 'agent' })

    await restart()
    const clearing = register('claude', 'local:1', session)
    expect(getRole(clearing.id)).toMatchObject({ role: '리뷰', roleSource: 'agent' })
    await clearing.setRole('')

    await restart()
    const cleared = register('claude', 'local:7', session)
    expect(getRole(cleared.id)).toMatchObject({ role: null, roleSource: null })
    expect(readFile()).toEqual({})
  })

  it('gives an explicit resume priority over discovery and lets displaced agents retry', async () => {
    await restart()
    const discovered = register('claude', 'local:1')
    messages.setVerifiedSession(discovered.id, session)
    messages.setUserRole(discovered.id, 'Design reviewer')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const resumed = register('claude', 'local:2', session)
      expect(getRole(resumed.id)).toMatchObject({ role: 'Design reviewer', roleSource: 'user' })
      expect(getRole(discovered.id)).toMatchObject({ role: null, roleSource: null })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Keeping ${resumed.id}`))

      messages.setVerifiedSession(discovered.id, session)
      messages.setVerifiedSession(discovered.id, session)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(getRole(discovered.id)).toMatchObject({ role: null })
      const alsoResumed = register('claude', 'local:3', session)
      expect(getRole(alsoResumed.id)).toMatchObject({ role: null })

      resumed.finish()
      locked = true
      messages.setVerifiedSession(discovered.id, session)
      expect(getRole(discovered.id)).toMatchObject({ role: 'Design reviewer', roleSource: 'user' })
    } finally {
      warn.mockRestore()
    }
  })

  it('copies both roles to an empty verified conversation and restores the destination roles when present', async () => {
    await restart()
    const codex = register('codex', 'local:1')
    messages.setVerifiedSession(codex.id, session)
    await codex.setRole('시험')
    messages.setUserRole(codex.id, '개발')
    messages.setVerifiedSession(codex.id, anotherSession)
    expect(readFile()).toMatchObject({
      [`codex:${session}`]: { agent: '시험', user: '개발' },
      [`codex:${anotherSession}`]: { agent: '시험', user: '개발' }
    })
    await codex.setRole('새 검토')
    expect(messages.setUserRole(codex.id, '')).toMatchObject({ role: '새 검토', roleSource: 'agent' })
    messages.setVerifiedSession(codex.id, session)
    expect(getRole(codex.id)).toMatchObject({ role: '개발', roleSource: 'user' })

    messages.registerLocalAntigravity(directory, () => ({ shellId: 'local:2' }), null)
    const agy = messages.snapshot().agents.find(agent => agent.kind === 'antigravity')
    messages.setUserRole(agy.id, '연구')
    messages.setVerifiedSession(agy.id, session)
    messages.setVerifiedSession(agy.id, anotherSession)
    messages.setVerifiedSession(agy.id, null)
    expect(getRole(agy.id)).toMatchObject({ role: '연구', roleSource: 'user' })

    await restart()
    const restarted = register('codex', 'local:3')
    messages.setVerifiedSession(restarted.id, anotherSession)
    expect(getRole(restarted.id)).toMatchObject({ role: '새 검토', roleSource: 'agent' })
    messages.registerLocalAntigravity(directory, () => ({ shellId: 'local:4' }), session)
    expect(messages.snapshot().agents.find(agent => agent.kind === 'antigravity'))
      .toMatchObject({ role: '연구', roleSource: 'user' })
  })

  it('ignores a damaged file and replaces it on the next valid role change', async () => {
    fs.writeFileSync(file, '{broken')
    await restart()
    const agent = register('claude', 'local:1', session)
    expect(getRole(agent.id)).toMatchObject({ role: null, roleSource: null })
    messages.setUserRole(agent.id, '새 역할')
    expect(readFile()[`claude:${session}`]).toMatchObject({ user: '새 역할' })
  })

  it('revalidates saved role sources and keeps the newest 500 unexpired sessions', () => {
    const key = roleSessionKey('claude', session)
    const expired = roleSessionKey('codex', session)
    const entries = {
      [key]: { user: '나', agent: 'Ｃｏｄｅｘ－２', usedAt: now - 1 },
      [expired]: { user: '오래됨', usedAt: now - 31 * day },
      'claude:C:/not-a-uuid': { user: '경로', usedAt: now },
      [roleSessionKey('codex', anotherSession)]: { user: '제어\u0001', usedAt: now }
    }
    for (let i = 0; i < 499; i++) {
      const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`
      entries[roleSessionKey('antigravity', id)] = { user: '시험', usedAt: now - 1 }
    }
    fs.writeFileSync(file, JSON.stringify(entries))
    const roles = createAgentRoleStore(file, () => now)
    expect(roles.get(key)).toMatchObject({ user: '나' })
    expect(roles.get(key)).not.toHaveProperty('agent')
    expect(roles.get(expired)).toBeUndefined()
    const recent = roleSessionKey('claude', anotherSession)
    roles.update(recent, { user: '최근 역할' })
    expect(Object.keys(readFile())).toHaveLength(500)
    expect(readFile()).not.toHaveProperty(expired)
    expect(readFile()).not.toHaveProperty('claude:C:/not-a-uuid')
    expect(roles.get(recent)).toMatchObject({ user: '최근 역할' })
  })
})
