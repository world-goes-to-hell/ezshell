import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { connectionOptions } from './agentMessageMcp.js'
import { createAgentMessages } from './agentMessages.js'

describe('the MCP bridge for an agent started in a local terminal', () => {
  it('uses the ancestor app when a newer app has replaced the shared bridge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-bridge-test-'))
    const bridgeFile = path.join(root, 'agent-message-connection')
    const instanceFile = `${bridgeFile}.${process.pid}`
    const messages = createAgentMessages({ bridgeFile, notify: () => {}, isLocked: () => false })
    try {
      await messages.enableExternalBridge()
      const installed = fs.readFileSync(instanceFile, 'utf8')
      expect(fs.readFileSync(bridgeFile, 'utf8')).toBe(installed)
      const [executable, script, pipe, token] = installed.split('\n')
      const newer = [executable, script, 'newer-pipe', 'newer-token', ''].join('\n')
      fs.writeFileSync(`${bridgeFile}.${process.ppid}`, newer)
      fs.writeFileSync(bridgeFile, newer)

      const helper = Math.max(process.pid, process.ppid) + 1
      const cli = helper + 1
      const runtime = path.basename(process.execPath)
      const tree = vi.fn(async () => new Map([
        [helper, { parent: cli, name: runtime }],
        [cli, { parent: process.pid, name: 'claude' }],
        [process.pid, { parent: process.ppid, name: runtime }]
      ]))
      const env = { EZSHELL_AGENT_BRIDGE_FILE: bridgeFile, EZSHELL_AGENT_BRIDGE_KIND: 'claude' }
      expect(await connectionOptions(env, tree, helper)).toEqual({ pipe, token, kind: 'claude' })
      expect(await connectionOptions(env, tree, cli + 1)).toEqual({ pipe: 'newer-pipe', token: 'newer-token', kind: 'claude' })

      tree.mockClear()
      expect(await connectionOptions({ ...env, EZSHELL_AGENT_PIPE: pipe }, tree, helper)).toEqual({ pipe, token, kind: 'claude' })
      expect(await connectionOptions({ ...env, EZSHELL_AGENT_PIPE: 'dedicated-pipe', EZSHELL_AGENT_TOKEN: 'dedicated-token' }, tree, helper))
        .toEqual({ pipe: 'dedicated-pipe', token: 'dedicated-token' })
      expect(tree).not.toHaveBeenCalled()

      messages.stop()
      expect(fs.existsSync(instanceFile)).toBe(false)
      expect(fs.readFileSync(bridgeFile, 'utf8')).toBe(newer)
    } finally {
      messages.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
