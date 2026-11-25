import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import script from './agents.js?raw'

class Node extends EventTarget {
  constructor(tag, text = '') {
    super()
    Object.assign(this, { tag, text, className: '', children: [], dataset: {}, hidden: false, attributes: {} })
    this.classList = { add: name => { this.className += ` ${name}` }, toggle() {} }
  }

  get textContent() { return this.text + this.children.map(child => child.textContent).join('') }
  set textContent(text) { this.text = String(text); this.children = [] }
  get firstElementChild() { return this.children[0] }
  get lastElementChild() { return this.children.at(-1) }

  insert(index, nodes) {
    const children = nodes.flatMap(node => node.tag === '#fragment' ? node.children : [node])
    this.children.splice(index, 0, ...children)
    for (const child of children) child.parentElement = this
  }

  append(...children) { this.insert(this.children.length, children) }
  prepend(...children) { this.insert(0, children) }
  replaceChildren(...children) { this.children = []; this.append(...children) }
  replaceWith(node) {
    const parent = this.parentElement
    const index = parent.children.indexOf(this)
    this.remove()
    parent.insert(index, [node])
  }

  remove() { this.parentElement.children = this.parentElement.children.filter(node => node !== this) }
  setAttribute(name, value) { this.attributes[name] = value }
  removeAttribute(name) { delete this.attributes[name] }
  contains(node) { return this === node || this.children.some(child => child.contains(node)) }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith('.') ? node.className.split(/\s+/).includes(selector.slice(1)) : node.tag === selector
    return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)])
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
}

function openChat(status = 'idle') {
  const window = {}
  const document = Object.assign(new EventTarget(), {
    createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag),
    createTextNode: text => new Node('#text', text), createDocumentFragment: () => new Node('#fragment')
  })
  runInNewContext(script, { window, document, setTimeout, clearTimeout, performance })
  const chat = new Node('main')
  const send = vi.fn()
  const list = new Node('aside')
  const phone = window.ezRemote.createAgents({ chat, list, send })
  const message = (type, frame) => phone.onMessage({ ...frame, type, shellId: 'local:1' })
  phone.enter()
  phone.reopen({ shellId: 'local:1', agentId: 'claude-1', kind: 'claude', status })
  message('chat-opened', { ok: true })
  return { chat, list, send, nameOf: phone.nameOf, message, frame: fields => message('chat-frame', fields) }
}

afterEach(() => vi.useRealTimers())

it('uses the PC display name with an optional trimmed role', () => {
  const { nameOf } = openChat()
  const agent = { name: 'Codex 9', agentId: 'codex-9' }
  expect(nameOf({ ...agent, role: '  리뷰어  ' })).toBe('리뷰어 · Codex 9')
  expect(nameOf({ ...agent, role: '   ' })).toBe('Codex 9')
  expect(nameOf({ agentId: 'codex-9' })).toBe('codex-9')
  expect(nameOf({})).toBe('에이전트')
})

it('shows a provider logo and a status SVG on each compact agent chip', () => {
  const { list, message } = openChat()
  message('agents', { agents: [
    { shellId: 'local:1', agentId: 'claude-1', kind: 'claude', status: 'working', name: 'Claude Code 1' },
    { shellId: 'local:2', agentId: 'codex-2', kind: 'codex', status: 'idle', name: 'Codex 2' },
    { shellId: 'local:3', agentId: 'antigravity-3', kind: 'antigravity', status: 'working', waitingApproval: true, name: 'Antigravity 3' }
  ] })
  const chips = list.querySelectorAll('.remote-agent-chip')
  expect(chips.map(chip => chip.attributes['aria-label'])).toEqual([
    'Claude Code 1 · 작업 중', 'Codex 2 · 쉬는 중', 'Antigravity 3 · 확인 대기'
  ])
  expect(chips.map(chip => chip.dataset.agentWork)).toEqual(['working', 'idle', 'idle'])
  const paths = chips.map(chip => {
    const icons = chip.querySelectorAll('svg')
    expect(icons.map(icon => icon.attributes.viewBox)).toEqual(['0 0 24 24', '0 0 24 24'])
    expect(icons.every(icon => icon.attributes['aria-hidden'] === 'true')).toBe(true)
    return icons.map(icon => icon.querySelector('path').attributes.d)
  })
  expect(new Set(paths.flat()).size).toBe(6)
})

it('shows the send time and keeps per-question usage on the final row across frame updates', () => {
  const { chat, frame } = openChat()
  const sentAt = Date.parse('2026-11-25T00:30:00Z')
  const first = { id: 'user:1', kind: 'user', time: sentAt + 1000, sentAt, text: '<img src="example">' }
  const answer = { id: 'answer:1', kind: 'assistant', text: '확인했습니다.' }
  const usage = { input: 123_000, cached: 120_540, output: 3412, durationMs: 52_000, limits: { fiveHour: { before: 20, after: 23, used: 3 } } }
  frame({ reset: true, items: [first, answer] })
  expect(chat.querySelector('time')?.dateTime).toBe(new Date(sentAt).toISOString())
  expect(chat.querySelector('img')).toBeNull()
  expect(chat.querySelector('.remote-chat-user').textContent).toBe(first.text)
  expect(chat.querySelector('.workspace-return')).toBeNull()

  frame({ items: [{ ...first, usage }] })
  const lines = () => chat.querySelectorAll('.remote-chat-usage').map(line => [line.parentElement.dataset.id, line.textContent])
  expect(lines()).toEqual([[answer.id, '토큰 입력 12.3만 · 출력 3,412 · 캐시 98% · 52초 · 5시간 20% → 23% (+3%p)']])
  const older = { id: 'user:0', kind: 'user', text: '이전 질문', usage: { input: 10, cached: 0, output: 5 } }
  const details = { id: 'tool:1', kind: 'tool', tool: { name: 'Bash', summary: 'npm run build', input: '$ npm run build', result: '완료' } }
  frame({ older: true, items: [older] })
  frame({ items: [details] })
  expect(lines().map(([id]) => id)).toEqual([older.id, details.id])
  const detail = chat.querySelector('details')
  expect(detail.querySelector('.remote-chat-tool-summary').textContent).toBe('npm run build')
  detail.open = true
  frame({ items: [{ ...details, tool: { ...details.tool, result: '빌드 완료' } }] })
  expect(chat.querySelector('details').open).toBe(true)
  expect(chat.querySelector('details').querySelectorAll('pre').at(-1).textContent).toBe('빌드 완료')
})

it('puts the working line by the input and keeps numbered approval buttons armed after 800 ms', () => {
  vi.useFakeTimers()
  const { chat, frame, send } = openChat('working')
  expect(chat.querySelector('.remote-chat-progress')?.hidden).toBe(false)
  expect(chat.querySelector('.remote-chat-composer').querySelector('.remote-chat-stop')?.hidden).toBe(false)
  const signature = 'approval-1'
  frame({ approval: { signature, question: '진행할까요?', detail: ['Bash command', 'npm run build'], options: [
    { key: '1', label: 'Yes' }, { key: '2', label: 'Yes, and don’t ask again', phoneBlocked: true }
  ] } })
  expect(chat.querySelector('.remote-chat-progress').hidden).toBe(true)
  const [option, standing] = chat.querySelectorAll('.remote-chat-approval-option')
  expect(option.querySelector('.remote-chat-approval-key').textContent).toBe('1')
  expect(option.disabled).toBe(true)
  option.dispatchEvent(new Event('click'))
  expect(send.mock.calls.some(([message]) => message.type === 'chat-answer')).toBe(false)
  vi.advanceTimersByTime(799)
  expect(option.disabled).toBe(true)
  vi.advanceTimersByTime(1)
  expect(option.disabled).toBe(false)
  expect(standing.querySelector('.remote-chat-approval-pc-only')?.textContent).toBe('PC에서만')
  expect(standing.disabled).toBe(true)
  standing.dispatchEvent(new Event('click'))
  expect(send.mock.calls.some(([message]) => message.type === 'chat-answer')).toBe(false)
  option.dispatchEvent(new Event('click'))
  expect(send).toHaveBeenLastCalledWith({ type: 'chat-answer', shellId: 'local:1', key: '1', signature })
  frame({ approval: { signature: 'trust', terminalOnly: 'folder-trust', options: [] } })
  expect(chat.querySelector('.remote-chat-approval-option')).toBeNull()
  expect(chat.querySelector('.remote-chat-approval').textContent).toContain('PC의 터미널에서 응답')
})
