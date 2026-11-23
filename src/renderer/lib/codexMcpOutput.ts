type McpStatus = 'connected' | 'failed' | 'auth' | 'other'

export interface McpServerStatus {
  name: string
  status: McpStatus
  label: string
  tools: number
  loginCommand?: string
}

const HEADING = /^(?:🔌\uFE0F?\s*)?MCP Tools$/u
const SERVER = /^•\s+([^:]+):\s+([^()]+)\s+\(([0-9]+) tools?\)$/u
const LOGIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/

export function parseCodexMcpOutput(text: string): McpServerStatus[] | null {
  const lines = text.split(/\r?\n/).map(line => line.trim())
  if (!HEADING.test(lines.find(Boolean) ?? '')) return null

  const servers: McpServerStatus[] = []
  for (const line of lines) {
    const row = SERVER.exec(line)
    if (!row) continue
    const name = row[1].trim()
    const label = row[2].trim()
    const tools = Number(row[3])
    if (!name || !label || !Number.isSafeInteger(tools)) continue
    const state = label.toLowerCase()
    const status = state === 'authentication required' ? 'auth'
      : state === 'connected' || state === 'failed' ? state : 'other'
    const loginCommand = status === 'auth' && LOGIN_NAME.test(name) ? `/mcp login ${name}` : undefined
    servers.push({ name, status, label, tools, loginCommand })
  }
  return servers.length ? servers : null
}
