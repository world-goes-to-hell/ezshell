import { describe, expect, it } from 'vitest'
import { allSlashCommands, draftFor, isSlashCommand, matchSlashCommands } from './slashCommands'

describe('the chat composer\'s slash command list', () => {
  const commands = allSlashCommands('claude', [
    { name: '/q-copy', description: '질문 복사', source: 'user' },
    { name: '/compact', description: '덮어쓰지 않음', source: 'project' }
  ])

  it('keeps the CLI\'s own command over a user\'s of the same name', () => {
    expect(commands.filter(command => command.name === '/compact')).toHaveLength(1)
    expect(commands.find(command => command.name === '/compact')?.source).toBe('builtin')
    expect(commands.some(command => command.name === '/q-copy')).toBe(true)
  })

  it('shows while one word after "/" is typed: names that start with it, then contain it, then descriptions', () => {
    expect(matchSlashCommands('/', commands)?.length).toBeGreaterThan(10)
    const names = matchSlashCommands('/co', commands)?.map(command => command.name)
    expect(names?.slice(0, 4)).toEqual(['/compact', '/config', '/context', '/cost'])
    expect(matchSlashCommands('/복사', commands)?.map(command => command.name)).toEqual(['/q-copy'])
    expect(matchSlashCommands('/compact 요약', commands)).toBeNull()
    expect(matchSlashCommands('/tmp/a', commands)).toBeNull()
    expect(matchSlashCommands('안녕', commands)).toBeNull()
  })

  it('tells a command from a path, and fills a picked command for its value', () => {
    expect(isSlashCommand('/model sonnet')).toBe(true)
    expect(isSlashCommand('/status')).toBe(true)
    expect(isSlashCommand('/tmp/x 를 봐줘')).toBe(false)
    expect(draftFor({ name: '/model', description: '', source: 'builtin' })).toBe('/model ')
  })
})
