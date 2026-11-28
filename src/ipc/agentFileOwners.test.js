import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentFileOwners } from './agentFileOwners.js'
import { eventFromHookFields, validateAgentHookEvent } from './agentHookEvent.js'

// docs/plan/2026-11-28-agent-file-owners.md: a change in the repository belongs to the agent whose tool was open
const TOP = path.resolve('/work/app')
const CWD = path.join(TOP, 'src')
let clock
let listener
let changed
let notified
let owners
let sent
let running
const list = async top => (await owners.owners(top)).owners

function setup({ roles = {} } = {}) {
  clock = 1_000_000
  listener = undefined
  changed = []
  notified = []
  sent = []
  running = []
  owners = createAgentFileOwners({
    repoTopOf: async () => TOP,
    changedPaths: async () => changed,
    agentOf: id => ({ kind: id.split('-')[0], ...(roles[id] ? { role: roles[id] } : {}) }),
    notify: top => notified.push(top),
    listAgents: () => running,
    send: async (id, text, { urgent }) => { sent.push({ id, text, urgent }) },
    watch: (_root, callback) => { listener = callback; return { close: vi.fn(), on: vi.fn() } },
    now: () => clock
  })
}

const hook = (id, event, extra = {}) => owners.hook(id, { kind: id.split('-')[0], cwd: CWD, report: { kind: id.split('-')[0], event, startedAt: clock, ...extra } })
const write = file => listener('change', file.split('/').join(path.sep))
async function advance(ms) {
  clock += ms
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  setup({ roles: { 'claude-2': '개발A', 'codex-5': '개발C' } })
})
afterEach(() => vi.useRealTimers())

describe('agent file owners', () => {
  it('gives a file to the agent whose edit tool was open when it changed', async () => {
    hook('claude-2', 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(0) // the repository top resolves, the watch starts
    hook('claude-2', 'PreToolUse', { toolUseId: 'toolu_1', tool: 'Edit' })
    await advance(100)
    write('src/app.js')
    await advance(200)
    hook('claude-2', 'PostToolUse', { toolUseId: 'toolu_1' })
    await advance(3500)
    changed = ['src/app.js']
    expect(await list(TOP)).toEqual([
      { path: 'src/app.js', agents: [{ id: 'claude-2', kind: 'claude', role: '개발A', lastAt: 1_000_100 }], uncertain: false }
    ])
    expect(notified).toEqual([TOP])
  })

  it('counts a write a little before the late PreToolUse report', async () => {
    hook('claude-2', 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(0)
    await advance(5000)
    write('a.txt')
    await advance(800)
    hook('claude-2', 'PreToolUse', { toolUseId: 'toolu_1', tool: 'Write' })
    await advance(100)
    hook('claude-2', 'PostToolUse', { toolUseId: 'toolu_1' })
    await advance(3500)
    changed = ['a.txt']
    expect((await list(TOP))[0].agents.map(agent => agent.id)).toEqual(['claude-2'])
  })

  it('prefers the agent editing over one running a shell command at the same time', async () => {
    hook('claude-2', 'UserPromptSubmit')
    hook('codex-5', 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(0)
    hook('claude-2', 'PreToolUse', { toolUseId: 'toolu_1' }) // a shell command, no edit tool name
    hook('codex-5', 'PreToolUse', { toolUseId: 'call_1', tool: 'apply_patch' })
    await advance(100)
    write('b.js')
    await advance(3500)
    changed = ['b.js']
    expect(await list(TOP)).toEqual([
      { path: 'b.js', agents: [{ id: 'codex-5', kind: 'codex', role: '개발C', lastAt: 1_000_100 }], uncertain: false }
    ])
  })

  it('marks a guess when two agents ran tools at that moment, and lists both', async () => {
    hook('claude-2', 'UserPromptSubmit')
    hook('codex-5', 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(0)
    hook('claude-2', 'PreToolUse', { toolUseId: 'toolu_1' })
    hook('codex-5', 'PreToolUse', { toolUseId: 'call_1' })
    await advance(100)
    write('c.js')
    await advance(3500)
    changed = ['c.js']
    const [entry] = await list(TOP)
    expect(entry.uncertain).toBe(true)
    expect(entry.agents.map(agent => agent.id).sort()).toEqual(['claude-2', 'codex-5'])
  })

  it('shows two agents who changed the same file one after the other, newest first', async () => {
    changed = ['d.js']
    hook('claude-2', 'UserPromptSubmit')
    hook('codex-5', 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(0)
    hook('claude-2', 'PreToolUse', { toolUseId: 'toolu_1', tool: 'Edit' })
    write('d.js')
    hook('claude-2', 'PostToolUse', { toolUseId: 'toolu_1' })
    await advance(10_000)
    hook('codex-5', 'PreToolUse', { toolUseId: 'call_1', tool: 'apply_patch' })
    write('d.js')
    hook('codex-5', 'PostToolUse', { toolUseId: 'call_1' })
    await advance(3500)
    changed = ['d.js']
    const [entry] = await list(TOP)
    expect(entry.agents.map(agent => agent.id)).toEqual(['codex-5', 'claude-2'])
    expect(entry.uncertain).toBe(false)
  })

  it('falls back to the open turn (a subagent or a background command) and leaves changes outside any turn alone', async () => {
    hook('claude-2', 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(0)
    write('e.js')
    await advance(1000)
    hook('claude-2', 'Stop')
    await advance(10_000)
    write('f.js') // nobody was working: the user, a build
    await advance(3500)
    changed = ['e.js', 'f.js']
    expect((await list(TOP)).map(entry => entry.path)).toEqual(['e.js'])
  })

  it('forgets a file once Git no longer lists it, so the next change starts over', async () => {
    hook('claude-2', 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(0)
    write('g.js')
    await advance(3500)
    changed = []
    expect(await list(TOP)).toEqual([])
    changed = ['g.js']
    expect(await list(TOP)).toEqual([])
  })

  it('keeps the files of a nested repository the outer status shows as one folder', async () => {
    hook('claude-2', 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(0)
    write('sub/x.js')
    await advance(3500)
    changed = ['sub/']
    expect(await list(TOP)).toEqual([])
    changed = ['x.js']
    expect((await list(path.join(TOP, 'sub'))).map(entry => entry.path)).toEqual(['x.js'])
  })

  it('ignores Git\'s folder and installed or generated folders', async () => {
    hook('claude-2', 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(0)
    write('.git/index')
    write('node_modules/x/index.js')
    write('out/main/index.js')
    listener('change', null)
    await advance(3500)
    changed = ['.git/index', 'node_modules/x/index.js', 'out/main/index.js']
    expect(await list(TOP)).toEqual([])
    expect(notified).toEqual([])
  })

  it('takes no subagent reports and forgets everything on lock', async () => {
    owners.hook('claude-2', { kind: 'claude', cwd: CWD, report: { kind: 'claude', event: 'UserPromptSubmit', startedAt: clock, subagent: true } })
    await vi.advanceTimersByTimeAsync(0)
    expect(listener).toBeUndefined()
    hook('claude-2', 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(0)
    write('h.js')
    await advance(3500)
    owners.clear()
    changed = ['h.js']
    expect(await list(TOP)).toEqual([])
  })
})

describe('telling agents (user decisions of 2026-11-28)', () => {
  async function edit(id, file, toolUseId) {
    hook(id, 'PreToolUse', { toolUseId, tool: id.startsWith('codex') ? 'apply_patch' : 'Edit' })
    write(file)
    hook(id, 'PostToolUse', { toolUseId })
    await advance(3500)
  }
  async function start() {
    hook('claude-2', 'UserPromptSubmit')
    hook('codex-5', 'UserPromptSubmit')
    await vi.advanceTimersByTimeAsync(0)
  }

  it('tells the agent that changed a file another agent changed before, once', async () => {
    await start()
    changed = ['d.js']
    await edit('claude-2', 'd.js', 'toolu_1')
    expect(sent).toEqual([])
    await edit('codex-5', 'd.js', 'call_1')
    expect(sent).toEqual([{ id: 'codex-5', urgent: false, text: expect.stringContaining('`d.js`: 개발A(claude-2)') }])
    await edit('codex-5', 'd.js', 'call_2')
    expect(sent).toHaveLength(1)
    await edit('claude-2', 'd.js', 'toolu_2') // the other way round is a new pair
    expect(sent.map(message => message.id)).toEqual(['codex-5', 'claude-2'])
  })

  it('says nothing once the first change was committed (Git wrote its index)', async () => {
    await start()
    changed = ['d.js']
    await edit('claude-2', 'd.js', 'toolu_1')
    changed = []
    listener('change', path.join('.git', 'index'))
    await advance(1100)
    changed = ['d.js']
    await edit('codex-5', 'd.js', 'call_1')
    expect(sent).toEqual([])
    expect((await list(TOP))[0].agents.map(agent => agent.id)).toEqual(['codex-5'])
  })

  it('says nothing on a guess', async () => {
    await start()
    changed = ['d.js']
    await edit('claude-2', 'd.js', 'toolu_1')
    hook('claude-2', 'PreToolUse', { toolUseId: 'toolu_2' })
    hook('codex-5', 'PreToolUse', { toolUseId: 'call_1' })
    write('d.js')
    await advance(3500)
    expect(sent).toEqual([])
  })

  it('announces a freeze to the repository\'s other agents, warns one that still changes a file, and the thaw', async () => {
    await start()
    running = [
      { id: 'claude-2', kind: 'claude', cwd: CWD },
      { id: 'codex-5', kind: 'codex', cwd: TOP },
      { id: 'claude-1', kind: 'claude', cwd: CWD }
    ]
    const { freeze } = await owners.freeze(TOP, { frozen: true, except: 'claude-1', reason: '병합 중' })
    expect(freeze).toEqual({ since: clock, except: { id: 'claude-1' }, reason: '병합 중' })
    expect(sent.map(({ id, urgent }) => ({ id, urgent }))).toEqual([{ id: 'claude-2', urgent: true }, { id: 'codex-5', urgent: true }])
    expect(sent[0].text).toContain('claude-1 만 계속 작업합니다. 이유: 병합 중')
    expect((await owners.owners(TOP)).freeze).toMatchObject({ reason: '병합 중' })
    sent.length = 0
    changed = ['e.js']
    await edit('codex-5', 'e.js', 'call_1')
    await edit('codex-5', 'e.js', 'call_2')
    expect(sent).toEqual([{ id: 'codex-5', urgent: true, text: expect.stringContaining('`e.js` 이 바뀌었습니다') }])
    sent.length = 0
    expect(await owners.freeze(TOP, { frozen: false })).toEqual({ freeze: null })
    expect(sent.map(({ id, urgent }) => ({ id, urgent }))).toEqual([{ id: 'claude-2', urgent: false }, { id: 'codex-5', urgent: false }])
    expect(sent[0].text).toContain('동결이 풀렸습니다')
  })

  it('checks what a freeze request names', async () => {
    await expect(owners.freeze(TOP, { frozen: 'yes' })).rejects.toThrow()
    await expect(owners.freeze(TOP, { frozen: true, except: 'user' })).rejects.toThrow()
    await expect(owners.freeze(TOP, { frozen: true, reason: '줄\n바꿈' })).rejects.toThrow()
    await expect(owners.freeze(TOP, { frozen: true, reason: 'x'.repeat(201) })).rejects.toThrow()
    expect(await owners.freeze(TOP, { frozen: false })).toEqual({ freeze: null })
    expect(sent).toEqual([])
  })
})

describe('hook tool names', () => {
  const ID = '11111111-2222-4333-8444-555555555555'
  it('keeps the names of tools that write files on PreToolUse, never other names', () => {
    expect(eventFromHookFields('claude', { hook_event_name: 'PreToolUse', session_id: ID, tool_use_id: 'toolu_1', tool_name: 'Edit' }, 1)).toMatchObject({ tool: 'Edit' })
    expect(eventFromHookFields('codex', { hook_event_name: 'PreToolUse', turn_id: 't1', tool_use_id: 'call_1', tool_name: 'apply_patch' }, 1)).toMatchObject({ tool: 'apply_patch' })
    expect(eventFromHookFields('claude', { hook_event_name: 'PreToolUse', tool_use_id: 'toolu_1', tool_name: 'Bash' }, 1).tool).toBeUndefined()
    expect(eventFromHookFields('codex', { hook_event_name: 'PreToolUse', turn_id: 't1', tool_name: 'Edit' }, 1).tool).toBeUndefined()
    expect(eventFromHookFields('claude', { hook_event_name: 'PostToolUse', tool_use_id: 'toolu_1', tool_name: 'Edit' }, 1).tool).toBeUndefined()
  })

  it('rejects an edit tool name on another event or for the other CLI', () => {
    expect(validateAgentHookEvent({ kind: 'claude', event: 'PostToolUse', startedAt: 1, tool: 'Edit' })).toBeNull()
    expect(validateAgentHookEvent({ kind: 'claude', event: 'PreToolUse', startedAt: 1, tool: 'apply_patch' })).toBeNull()
    expect(validateAgentHookEvent({ kind: 'codex', event: 'PreToolUse', startedAt: 1, tool: 'AskUserQuestion' })).toBeNull()
    expect(validateAgentHookEvent({ kind: 'claude', event: 'PostToolUse', startedAt: 1, tool: 'AskUserQuestion' })).toMatchObject({ tool: 'AskUserQuestion' })
  })
})
