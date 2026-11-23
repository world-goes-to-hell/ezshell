import { describe, expect, it } from 'vitest'
import type { TerminalInfo } from '../stores/terminalStore'
import { agentDisplayName, agentIdentityColor, agentMessageMatches, agentPaneLocation, agentSearchTerm } from './agentIdentity'
import { MAIN_PANE, singlePane, splitPane, swapPanes } from './splitTree'
import { AGENT_PROVIDER_ICONS, AGENT_PROVIDER_NAMES } from '../components/ui/agentProviderIcons'

describe('agent identity', () => {
  it('shares named icons for Claude Code, Codex, and Antigravity', () => {
    expect(AGENT_PROVIDER_NAMES).toEqual({ claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' })
    for (const provider of ['claude', 'codex', 'antigravity'] as const) expect(AGENT_PROVIDER_ICONS[provider]).toBeTypeOf('function')
  })

  it('assigns adjacent session IDs distinct palette colors and keeps the same ID stable', () => {
    const providers = ['codex', 'claude', 'antigravity']
    const ids = Array.from({ length: 40 }, (_, i) => `${providers[i % providers.length]}-${i + 1}`)
    const colors = ids.map(agentIdentityColor)
    expect(new Set(colors).size).toBe(ids.length)
    expect(agentIdentityColor(ids[2])).toBe(colors[2])
  })

  it('finds the numbered pane in reading order and prefers roles over automatic names', () => {
    const tab: TerminalInfo = { id: 'tab', title: '테스트 탭', host: '', username: '', connected: true,
      local: { shell: 'pwsh', cwd: 'C:\\work' }, splitTree: splitPane(singlePane(), MAIN_PANE, 'row', 'split-1') }
    const shellAt = (pane: string) => pane === MAIN_PANE ? 'local:1' : 'local:2'
    const location = agentPaneLocation(tab, 'local:2', shellAt)
    expect(location).toEqual({ tabId: 'tab', pane: 'split-1', tabLabel: '테스트 탭', number: 2, label: '테스트 탭 · 칸 2' })
    const rotated = swapPanes(tab.splitTree!, MAIN_PANE, 'split-1')
    expect(agentPaneLocation({ ...tab, splitTree: rotated }, 'local:2', shellAt)?.label).toBe('테스트 탭 · 칸 1')
    expect(agentPaneLocation(tab, 'local:3', shellAt)).toBeUndefined()
    const agent = { id: 'codex-1', cwd: 'C:\\work' }
    expect(agentDisplayName({ ...agent, role: 'PL' }, location)).toBe('PL')
    expect(agentDisplayName(agent, location)).toBe(location?.label)
    expect(agentDisplayName(agent)).toBe('work')
  })

  it('matches message bodies, both IDs, and both roles with Unicode normalization', () => {
    const message = { id: 'm1', from: 'codex-1', to: 'claude-2', text: 'Café 작업', sentAt: 1, read: false }
    const roles = new Map([['codex-1', '플랜'], ['claude-2', 'Reviewer']])
    for (const query of ['CAFE\u0301', ' CLAUDE-2 ', 'reviewer', '플랜']) {
      expect(agentMessageMatches(message, agentSearchTerm(query), roles)).toBe(true)
    }
    expect(agentMessageMatches(message, agentSearchTerm('다른 에이전트'), roles)).toBe(false)
  })
})
