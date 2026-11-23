import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAgentMessages } from './agentMessages.js'

// The relationship map keeps card positions under an opaque key of the agent's conversation
const session = 'c52f8001-53d1-43ea-8a89-7598f8baaf6c'
const another = 'e52f8001-53d1-43ea-8a89-7598f8baaf6c'
let directory
let messages

beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-layout-')) })
afterEach(() => {
  messages?.stop()
  messages = undefined
  fs.rmSync(directory, { recursive: true, force: true })
})

async function start() {
  messages?.stop()
  messages = createAgentMessages({ roleFile: path.join(directory, 'agent-roles.json'), notify: () => {}, isLocked: () => false, home: directory })
  await messages.ready()
}

const open = (kind, shellId, resume) => messages.register(kind, shellId, directory, {}, resume).env.EZSHELL_AGENT_ID
const keyOf = id => messages.snapshot().agents.find(agent => agent.id === id)?.layoutKey

describe('agent map layout key', () => {
  it('is a short opaque key of the conversation that survives a restart and never shows the conversation id', async () => {
    await start()
    const first = open('claude', 'local:1', session)
    const key = keyOf(first)
    expect(key).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(messages.snapshot().agents.map(({ layoutKey }) => layoutKey))).not.toContain(session.slice(0, 8))

    await start()
    const again = open('claude', 'local:2', session)
    expect(keyOf(again)).toBe(key)
    const other = open('claude', 'local:3', another)
    expect(keyOf(other)).toMatch(/^[0-9a-f]{16}$/)
    expect(keyOf(other)).not.toBe(key)
    const codex = open('codex', 'local:4', session)
    expect(keyOf(codex)).not.toBe(key)
  })

  it('is absent until the conversation is known', async () => {
    await start()
    expect(keyOf(open('codex', 'local:1'))).toBeNull()
  })
})
