import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { instructions } = require('./agentMessageMcp.js')

// The server instructions reach every connected agent on every turn
describe('message MCP instructions', () => {
  it('stays short', () => {
    expect(instructions.length).toBeLessThan(2000)
  })

  it('tells agents to find a recipient by role through list_agents', () => {
    expect(instructions).toMatch(/by role[^.]*list_agents/)
  })

  it('asks for requests that stand alone', () => {
    expect(instructions).toMatch(/cannot see your conversation/)
  })

  it('checks the recipient before sending again instead of resending on unread alone', () => {
    expect(instructions).not.toMatch(/stays unread for long, send it again/)
    expect(instructions).toMatch(/Before sending again, call inspect_agent/)
    expect(instructions).toMatch(/escalate/)
  })
})
