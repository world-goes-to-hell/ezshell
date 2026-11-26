import { describe, expect, it } from 'vitest'
import { chooseProject, chooseRecipient } from './browserReviewProjects'

const projects = [
  { folder: 'D:\work\shop\backend', name: 'shop / backend', agentIds: ['claude-6'] },
  { folder: 'D:\work\shop\frontend', name: 'shop / frontend', agentIds: ['claude-8', 'codex-2'] }
]

describe('browser element request projects', () => {
  it('keeps the chosen project, else the one the tab was opened from, else the only one', () => {
    expect(chooseProject({ projects, preferred: projects[1].folder }, projects[0].folder)).toBe(projects[0].folder)
    expect(chooseProject({ projects, preferred: projects[1].folder }, '')).toBe(projects[1].folder)
    expect(chooseProject({ projects, preferred: null }, '')).toBe('')
    expect(chooseProject({ projects: projects.slice(0, 1), preferred: null }, '')).toBe(projects[0].folder)
    expect(chooseProject({ projects: projects.slice(1), preferred: null }, projects[0].folder)).toBe(projects[1].folder)
  })

  it('keeps the agent when it is still in the project, else picks the only agent of the project', () => {
    expect(chooseRecipient(projects[1], 'codex-2')).toBe('codex-2')
    expect(chooseRecipient(projects[1], 'claude-6')).toBe('')
    expect(chooseRecipient(projects[0], 'claude-8')).toBe('claude-6')
    expect(chooseRecipient(undefined, 'claude-8')).toBe('')
  })
})
