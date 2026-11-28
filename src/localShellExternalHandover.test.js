// A CLI the user typed in a kept shell (not launched by the app) through an update (2026-11-28 user report): the old
// app hands its process over with the shell, and the next app binds it again, so its MCP comes back under its id.
// Before, the shell came back with an agent and no binding; findAgentProcess skipped it and a typed Claude's MCP
// was refused for ever ("ezShell 로컬 터미널 연결을 확인할 수 없습니다").
import { describe, it, expect, vi } from 'vitest'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createLocalShells } from './localShell.js'
import { remotePty } from './sessionHost/client.js'

const DIR = realpathSync(tmpdir())

function fakeHost() {
  const sent = []
  const remotes = new Map()
  return {
    sent, remotes,
    ready: () => true,
    spawn: vi.fn((id) => {
      const remote = remotePty(id, message => sent.push(message))
      remotes.set(id, { remote })
      remote.pty.pid = 700 + remotes.size
      return remote.pty
    }),
    adopt: vi.fn(shell => {
      const remote = remotePty(shell.id, message => sent.push(message))
      remote.pty.pid = shell.pid
      remotes.set(shell.id, { remote })
      return remote.pty
    }),
    setMeta: vi.fn()
  }
}

function setup({ host, processes, alive, agents = {} }) {
  return createLocalShells({
    spawn: vi.fn(), send: () => {}, killTrees: vi.fn(), host, agents,
    shell: { file: 'sh', args: [], name: 'sh' }, cwd: DIR, env: {}, commandLine: async () => '',
    processTree: async () => processes, processAlive: pid => alive.has(pid)
  })
}

describe('a CLI typed in a kept shell, through an update', () => {
  async function handedOver() {
    // Its MCP (15) under the Claude (12) the user started in the hosted shell (701)
    const processes = new Map([
      [15, { parent: 12, name: 'electron.exe' }],
      [12, { parent: 701, name: 'claude.exe', startedAt: 10_000 }]
    ])
    const alive = new Set([12, 15, 701])
    const host = fakeHost()
    const old = setup({ host, processes, alive })
    const { id } = old.open({ cwd: DIR })
    const attach = await old.bindAgentProcess({ pid: 15, kind: 'claude' })
    attach({ agentId: 'claude-1', setStatus: vi.fn(), onExit: vi.fn() })
    old.handOver()
    // The meta goes through the pipe as JSON
    const meta = JSON.parse(JSON.stringify(host.setMeta.mock.calls.find(([shellId]) => shellId === id)[1]))
    return { id, meta, processes, alive }
  }

  it('hands over the process with the shell, and binds it again when its MCP connects under the same id', async () => {
    const { id, meta, processes, alive } = await handedOver()
    expect(meta).toMatchObject({ agent: 'claude', external: { pid: 12, hadMcp: true, mcpProcessStartedAt: 10_000 } })

    const registration = { setStatus: vi.fn(), finish: vi.fn(), close: vi.fn() }
    const agents = { adopt: vi.fn(() => registration), adoptShell: vi.fn(), agentsOfShell: shellId => (shellId === id ? ['claude-1'] : []) }
    const next = setup({ host: fakeHost(), processes, alive, agents })
    expect(next.adopt([{ id, pid: 701, meta, buffer: '', cols: 80, rows: 24, exited: false }])).toEqual([id])
    // The same CLI's MCP reconnects (a new MCP process 16, after the app restarted)
    processes.set(16, { parent: 12, name: 'electron.exe' })
    alive.add(16)
    const attach = await next.bindAgentProcess({ pid: 16, kind: 'claude', shellId: id })
    expect(attach).toBeTypeOf('function')
    const authorizeBinding = vi.fn()
    const onExit = vi.fn()
    expect(attach({ agentId: 'claude-9', setStatus: vi.fn(), onExit, authorizeBinding }).agentId).toBe('claude-1')
    // Its reconnect credential decides (agentMessages.js authenticReconnect); the same live CLI is known
    expect(authorizeBinding).toHaveBeenCalledExactlyOnceWith('claude-1', false, true)
    // From then on the CLI's exit ends that agent as any bound CLI's does
    alive.delete(12)
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledExactlyOnceWith('claude-1'), { timeout: 3000 })
    expect(registration.finish).not.toHaveBeenCalled()
    next.closeAll()
  })

  // The first update from an app before this (2.42.0) hands the shell over without `external`
  it('binds the CLI of a shell an older app handed over without it, only under the handed id and its credential', async () => {
    const { id, meta, processes, alive } = await handedOver()
    const { external, ...older } = meta
    expect(external).toBeTruthy()
    const registration = { setStatus: vi.fn(), finish: vi.fn(), close: vi.fn() }
    const agents = { adopt: vi.fn(() => registration), adoptShell: vi.fn(), agentsOfShell: () => ['claude-1'] }
    const next = setup({ host: fakeHost(), processes, alive, agents })
    next.adopt([{ id, pid: 701, meta: older, buffer: '', cols: 80, rows: 24, exited: false }])
    processes.set(16, { parent: 12, name: 'electron.exe' })
    alive.add(16)

    // A refused credential binds nothing, and the next try still can
    const refuse = vi.fn(() => { throw new Error('기존 에이전트에 다시 연결하려면 재연결 자격 증명이 필요합니다.') })
    const first = await next.bindAgentProcess({ pid: 16, kind: 'claude', shellId: id })
    expect(() => first({ agentId: 'claude-9', setStatus: vi.fn(), onExit: vi.fn(), authorizeBinding: refuse })).toThrow('재연결 자격 증명')
    expect(refuse).toHaveBeenCalledWith('claude-1', false, false)

    const authorizeBinding = vi.fn()
    const onExit = vi.fn()
    const second = await next.bindAgentProcess({ pid: 16, kind: 'claude', shellId: id })
    expect(second({ agentId: 'claude-9', setStatus: vi.fn(), onExit, authorizeBinding }).agentId).toBe('claude-1')
    alive.delete(12)
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledExactlyOnceWith('claude-1'), { timeout: 3000 })
    next.closeAll()
  })

  it('binds nothing when the CLI is gone by then, and a CLI that ends before its MCP is back ends its agent', async () => {
    const { id, meta, processes, alive } = await handedOver()
    alive.delete(12)
    const registration = { setStatus: vi.fn(), finish: vi.fn(), close: vi.fn() }
    const agents = { adopt: vi.fn(() => registration), adoptShell: vi.fn(), agentsOfShell: () => ['claude-1'] }
    const gone = setup({ host: fakeHost(), processes, alive, agents })
    gone.adopt([{ id, pid: 701, meta, buffer: '', cols: 80, rows: 24, exited: false }])
    const attach = await gone.bindAgentProcess({ pid: 15, kind: 'claude', shellId: id })
    const authorizeBinding = vi.fn()
    expect(attach?.({ agentId: 'claude-9', setStatus: vi.fn(), onExit: vi.fn(), authorizeBinding })).toBeUndefined()
    expect(authorizeBinding).not.toHaveBeenCalled()
    gone.closeAll()

    alive.add(12)
    const ending = setup({ host: fakeHost(), processes, alive, agents })
    ending.adopt([{ id, pid: 701, meta, buffer: '', cols: 80, rows: 24, exited: false }])
    alive.delete(12)
    await vi.waitFor(() => expect(registration.finish).toHaveBeenCalledExactlyOnceWith(null), { timeout: 3000 })
    ending.closeAll()
  })
})
