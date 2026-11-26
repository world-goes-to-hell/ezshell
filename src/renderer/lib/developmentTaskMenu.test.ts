import { describe, expect, it } from 'vitest'
import type { LocalDevelopmentTask } from '../types'
import { FLAT_TASK_LIMIT, developmentTaskLabel, developmentTaskMenu } from './developmentTaskMenu'

const task = (name: string, relative: string): LocalDevelopmentTask =>
  ({ id: `${relative}:${name}`, name, relative, command: 'run', includeSource: false })

describe('developmentTaskMenu', () => {
  it('lists a few tasks directly, the worktree module first, then by kind', () => {
    const menu = developmentTaskMenu([task('Vue', 'web'), task('Node', 'tools'), task('Spring Boot', 'api'), task('Spring Boot', 'batch')], 'batch')
    expect(menu.groups).toEqual([])
    expect(menu.direct.map(item => item.relative)).toEqual(['batch', 'api', 'web', 'tools'])
  })

  it('groups many tasks by kind, Spring Boot before Vue, names in order', () => {
    const tasks = [
      task('Vue', 'ris_vue'), task('Spring Boot', 'gateway-server'), task('Spring Boot', 'config-server'),
      task('Vue', 'integration'), task('Spring Boot', 'ktsn-service'), task('Spring Boot', 'eureka-server'),
      task('Vue', 'digitalarchive'), task('Spring Boot', 'ris-service'), task('Node', 'scripts')
    ]
    expect(tasks.length).toBeGreaterThan(FLAT_TASK_LIMIT)
    const menu = developmentTaskMenu(tasks, 'ktsn-service')
    expect(menu.direct.map(item => item.relative)).toEqual(['ktsn-service'])
    expect(menu.groups.map(group => [group.kind, group.tasks.map(item => item.relative)])).toEqual([
      ['Spring Boot', ['config-server', 'eureka-server', 'gateway-server', 'ris-service']],
      ['Vue', ['digitalarchive', 'integration', 'ris_vue']],
      ['Node', ['scripts']]
    ])
  })

  it('keeps every task when nothing matches the worktree', () => {
    const tasks = Array.from({ length: 10 }, (_, index) => task(index % 2 ? 'Vue' : 'Spring Boot', `m${index}`))
    const menu = developmentTaskMenu(tasks, 'main')
    expect(menu.direct).toEqual([])
    expect(menu.groups.flatMap(group => group.tasks)).toHaveLength(10)
  })
})

describe('developmentTaskLabel', () => {
  it('names the kind directly and only the folder inside a group', () => {
    expect(developmentTaskLabel(task('Spring Boot', 'backend'))).toBe('Spring Boot 기동 · backend')
    expect(developmentTaskLabel(task('Vue', '.'))).toBe('Vue 기동')
    expect(developmentTaskLabel(task('Vue', 'web'), true)).toBe('web')
    expect(developmentTaskLabel(task('Vue', '.'), true)).toBe('저장소 루트')
  })
})
