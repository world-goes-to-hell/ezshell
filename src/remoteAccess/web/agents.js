// Read and control the PC's agent chat from the phone. Server text is always added as DOM text.
(() => {
  'use strict'
  const ns = (window.ezRemote = window.ezRemote || {})
  const MAX_TEXT = 16_000
  const MAX_ITEMS = 3000
  const ARM_MS = 800
  let nextRequest = 0
  const ACCESS_OFF = '휴대폰에서 에이전트 쓰기가 꺼져 있습니다. PC 설정의 원격 접속에서 켜 주세요.'
  const AGENT_CHANGED = 'PC에서 에이전트 세션이 바뀌었습니다.'
  const PROVIDERS = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }
  const STATUSES = {
    idle: '쉬는 중', working: '작업 중', blocked: '확인 대기', starting: '시작 중',
    sleeping: '잠듦', ended: '종료됨', error: '오류', unknown: '상태 확인 중'
  }
  const sendClock = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', hour12: true })
  const fullChatDate = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'full', timeStyle: 'medium' })

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }

  function button(text, className, action) {
    const node = el('button', className, text)
    node.type = 'button'
    node.addEventListener('click', action)
    return node
  }

  function statusOf(agent) {
    if (agent.waitingApproval) return 'blocked'
    return Object.hasOwn(STATUSES, agent.status) ? agent.status : 'unknown'
  }

  const providerOf = agent => Object.hasOwn(PROVIDERS, agent.kind) ? PROVIDERS[agent.kind] : '에이전트'
  const nameOf = agent => {
    const role = agent.role?.trim()
    const base = agent.name || agent.agentId || '에이전트'
    return role ? `${role} · ${base}` : base
  }

  function setStatus(node, status) {
    if (node.dataset.status === status) return
    node.dataset.status = status
    node.textContent = STATUSES[status]
  }

  function projectGroups(agents, reviewTabs) {
    const groups = new Map()
    function groupOf(item, folder) {
      const id = item.project?.id ?? (folder ? `folder:${folder}` : '')
      const name = item.project?.name || folder || '기타 로컬 작업'
      if (!groups.has(id)) groups.set(id, { id, name, agents: [], tabs: [] })
      return groups.get(id)
    }
    for (const agent of agents) groupOf(agent, agent.folderName).agents.push(agent)
    for (const tab of reviewTabs) groupOf(tab, tab.folder).tabs.push(tab)
    return [...groups.values()].sort((a, b) => Number(!a.id) - Number(!b.id) || a.name.localeCompare(b.name, 'ko'))
  }

  function appendInline(node, text) {
    let offset = 0
    for (const match of text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*/g)) {
      node.append(document.createTextNode(text.slice(offset, match.index)),
        match[1] === undefined ? el('strong', '', match[2]) : el('code', '', match[1]))
      offset = match.index + match[0].length
    }
    node.append(document.createTextNode(text.slice(offset)))
  }

  function appendAnswer(node, text) {
    let offset = 0
    for (const block of text.matchAll(/(?:^|\n)```[^\n]*\n([\s\S]*?)\n```(?=\n|$)/g)) {
      appendInline(node, text.slice(offset, block.index))
      const pre = el('pre')
      pre.append(el('code', '', block[1]))
      node.append(pre)
      offset = block.index + block[0].length
      if (text[offset] === '\n') offset++
    }
    appendInline(node, text.slice(offset))
  }

  function appendTimestamp(node, value) {
    if (!Number.isFinite(value)) return
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return
    const time = el('time', 'remote-chat-timestamp', sendClock.format(date))
    time.dateTime = date.toISOString()
    time.title = fullChatDate.format(date)
    node.append(time)
  }

  const isCount = value => Number.isFinite(value) && value >= 0

  function tokenCount(value) {
    if (value < 10_000) return value.toLocaleString('ko-KR')
    const man = value / 10_000
    return `${man < 100 ? man.toFixed(1).replace(/\.0$/, '') : Math.round(man)}만`
  }

  function turnUsageText(usage) {
    if (!isCount(usage?.input) || !isCount(usage?.output)) return ''
    const parts = [`토큰 입력 ${tokenCount(usage.input)}`, `출력 ${tokenCount(usage.output)}`]
    if (usage.input > 0 && isCount(usage.cached) && usage.cached > 0) {
      parts.push(`캐시 ${Math.round((Math.min(usage.cached, usage.input) / usage.input) * 100)}%`)
    }
    if (isCount(usage.durationMs) && usage.durationMs > 0) {
      const seconds = Math.max(1, Math.round(usage.durationMs / 1000))
      const minutes = Math.floor(seconds / 60)
      const rest = seconds % 60
      parts.push(minutes ? `${minutes}분${rest ? ` ${rest}초` : ''}` : `${seconds}초`)
    }
    for (const [period, label] of [['fiveHour', '5시간'], ['sevenDay', '주간']]) {
      const limit = usage.limits?.[period]
      if (!limit || ![limit.before, limit.after, limit.used].every(isCount)) continue
      const delta = limit.used > 0 ? `+${limit.used}%p` : ''
      const annotation = limit.reset === true ? (delta ? `초기화 후 ${delta}` : '초기화') : delta
      parts.push(`${label} ${limit.before}% → ${limit.after}%${annotation ? ` (${annotation})` : ''}`)
    }
    return parts.join(' · ')
  }

  function chatContent(item, expanded) {
    const text = typeof item.text === 'string' ? item.text : ''
    if (item.kind === 'user') {
      const message = el('div', 'remote-chat-outgoing')
      appendTimestamp(message, item.sentAt ?? item.time)
      message.append(el('div', 'remote-chat-user', text || (item.hasImage ? '이미지 첨부' : '')))
      return message
    }
    if (item.kind === 'assistant') {
      const message = el('div', 'remote-chat-incoming')
      const answer = el('div', 'remote-chat-answer')
      appendAnswer(answer, text)
      message.append(answer)
      appendTimestamp(message, item.time)
      return message
    }
    if (item.kind === 'notice') return el('p', 'remote-chat-notice', text)
    const tool = item.tool
    const label = item.kind === 'thinking' ? '생각' : item.kind === 'output' ? item.outputCommand || '출력'
      : item.kind === 'tool' && tool ? tool.name || '도구' : ''
    if (!label) return null
    const details = el('details', 'remote-chat-detail')
    details.open = expanded
    const summary = el('summary', 'remote-chat-tool-head')
    summary.append(el('span', 'remote-chat-tool-name', label))
    if (typeof tool?.summary === 'string' && tool.summary) {
      const description = el('span', 'remote-chat-tool-summary', tool.summary)
      description.title = tool.summary
      summary.append(description)
    }
    if (item.isError || tool?.isError) {
      details.dataset.error = 'true'
      summary.append(el('span', 'remote-chat-tool-failed', '실패'))
    }
    details.append(summary)
    const body = el('div', 'remote-chat-tool-body')
    const parts = tool ? [tool.input, tool.result, Array.isArray(tool.diff) ? tool.diff.join('\n') : ''] : [text]
    for (const part of parts) {
      if (typeof part === 'string' && part) body.append(el('pre', '', part))
    }
    if (body.firstElementChild) details.append(body)
    return details
  }

  ns.createAgents = function createAgents({ list, chat, send, onOpen, openReview }) {
    let watching = false
    let agents = null
    let reviewTabs = []
    let listError = ''
    let current = null
    let armTimer = null
    const rows = new Map()
    const foldedProjects = new Set()

    chat.classList.add('remote-chat-view')
    const listBar = el('header', 'bar')
    const listHeading = el('strong', '', '로컬 작업')
    listBar.append(listHeading)
    const cards = el('div', 'list remote-agent-cards')
    list.replaceChildren(listBar, cards)

    const stop = button('중지', 'remote-chat-stop', interrupt)
    const meta = el('header', 'remote-chat-meta')
    const provider = el('span', 'remote-agent-kind')
    const status = el('span', 'remote-agent-status')
    status.setAttribute('role', 'status')
    const paneTitle = el('strong', 'remote-chat-pane-title')
    meta.append(provider, paneTitle, status)

    const scroll = el('div', 'list remote-chat-scroll')
    scroll.setAttribute('aria-label', '대화 내용')
    scroll.tabIndex = 0
    const older = button('이전 대화 더 보기', 'remote-chat-older', requestOlder)
    const empty = el('p', 'empty remote-chat-empty')
    const turns = el('div', 'remote-chat-turns')
    scroll.append(older, empty, turns)
    scroll.addEventListener('scroll', () => {
      if (scroll.scrollTop < 30 && scroll.scrollHeight > scroll.clientHeight) requestOlder()
    }, { passive: true })

    const approvalCard = el('section', 'remote-chat-approval')
    approvalCard.setAttribute('aria-label', '에이전트의 확인 요청')
    const form = el('form', 'remote-chat-form')
    const note = el('p', 'remote-chat-note')
    note.setAttribute('role', 'status')
    const progress = el('p', 'remote-chat-progress', '작업 중…')
    progress.setAttribute('role', 'status')
    const input = el('textarea', 'remote-chat-input')
    input.rows = 1
    input.maxLength = MAX_TEXT
    input.setAttribute('aria-label', '에이전트에게 보낼 글')
    input.placeholder = '에이전트에게 보낼 글'
    const submit = el('button', 'primary remote-chat-send')
    submit.type = 'submit'
    const sendIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    sendIcon.setAttribute('class', 'send-glyph')
    sendIcon.setAttribute('aria-hidden', 'true')
    sendIcon.setAttribute('viewBox', '0 0 24 24')
    const sendPath = document.createElementNS(sendIcon.namespaceURI, 'path')
    // Remix Icon RiSendPlane2Line, also used by AgentChatCover.
    sendPath.setAttribute('d', 'M3.5 1.34558C3.58425 1.34558 3.66714 1.36687 3.74096 1.40747L22.2034 11.5618C22.4454 11.6949 22.5337 11.9989 22.4006 12.2409C22.3549 12.324 22.2865 12.3924 22.2034 12.4381L3.74096 22.5924C3.499 22.7255 3.19497 22.6372 3.06189 22.3953C3.02129 22.3214 3 22.2386 3 22.1543V1.84558C3 1.56944 3.22386 1.34558 3.5 1.34558ZM5 4.38249V10.9999H10V12.9999H5V19.6174L18.8499 11.9999L5 4.38249Z')
    sendIcon.append(sendPath)
    submit.append(sendIcon)
    const composer = el('div', 'remote-chat-composer')
    composer.append(input, stop, submit)
    form.append(note, progress, composer)
    form.addEventListener('submit', sendChat)
    input.addEventListener('input', () => {
      setNote(draftError(input.value), true)
      renderControls()
    })
    const pane = el('div', 'remote-chat-pane')
    pane.append(meta, scroll, approvalCard, form)
    chat.replaceChildren(pane)
    document.addEventListener('visibilitychange', armApproval)

    function setNote(text, error = false) {
      note.textContent = text
      note.hidden = !text
      note.classList.toggle('is-error', error)
    }

    function renderList() {
      const focus = cards.contains(document.activeElement) ? document.activeElement.dataset : {}
      cards.replaceChildren()
      if (listError) {
        const message = el('p', 'error', listError)
        message.setAttribute('role', 'status')
        cards.append(message)
      }
      if (!agents?.length && !reviewTabs.length) {
        if (!listError) cards.append(el('p', 'empty', agents ? '실행 중인 에이전트가 없습니다.' : '에이전트 목록을 불러오는 중…'))
        return
      }
      const fragment = document.createDocumentFragment()
      let focusedButton = null
      for (const group of projectGroups(agents ?? [], reviewTabs)) {
        const section = el('div', 'remote-agent-project')
        const children = el('div', 'remote-agent-project-children')
        const hasWork = group.agents.some(agent => statusOf(agent) === 'working')
        const toggle = button('', 'remote-agent-project-toggle', () => {
          if (foldedProjects.has(group.id)) foldedProjects.delete(group.id)
          else foldedProjects.add(group.id)
          updateFold()
        })
        const updateFold = () => {
          children.hidden = foldedProjects.has(group.id)
          toggle.setAttribute('aria-expanded', String(!children.hidden))
          const showsWork = children.hidden && hasWork
          toggle.dataset.agentWork = showsWork ? 'working' : 'idle'
          if (showsWork) toggle.setAttribute('aria-description', '작업 중인 에이전트 있음')
          else toggle.removeAttribute('aria-description')
        }
        toggle.dataset.projectId = group.id
        if (group.id === focus.projectId) focusedButton = toggle
        const name = el('strong', 'remote-agent-project-name', group.name)
        name.title = group.name
        const count = el('span', 'remote-agent-project-count', `${group.agents.length + group.tabs.length}개`)
        toggle.append(name, count)
        updateFold()
        for (const agent of group.agents) {
          const card = agentCard(agent, group.name)
          if (agent.shellId === focus.agentShellId) focusedButton = children.hidden ? toggle : card
          children.append(card)
        }
        for (const tab of group.tabs) {
          const row = button('', 'remote-agent-card', () => openReview(tab))
          row.dataset.reviewTabId = tab.id
          row.title = `${tab.name} · 브라우저 검토`
          const head = el('span', 'remote-agent-card-head')
          head.append(el('strong', 'remote-agent-name', tab.name), el('span', 'remote-agent-folder muted', '브라우저'))
          row.append(head)
          if (tab.id === focus.reviewTabId) focusedButton = children.hidden ? toggle : row
          children.append(row)
        }
        section.append(toggle, children)
        fragment.append(section)
      }
      cards.append(fragment)
      updateSelection()
      focusedButton?.focus({ preventScroll: true })
    }

    function agentCard(agent, projectName) {
      const card = button('', 'remote-agent-card', () => onOpen(agent))
      card.dataset.agentShellId = agent.shellId
      const state = statusOf(agent)
      card.dataset.agentWork = state === 'working' ? 'working' : 'idle'
      const head = el('span', 'remote-agent-card-head')
      const badge = el('span', 'remote-agent-status')
      setStatus(badge, state)
      const name = el('strong', 'remote-agent-name', nameOf(agent))
      name.title = name.textContent
      head.append(name, badge)
      const detail = el('span', 'remote-agent-card-meta')
      const kind = el('span', 'remote-agent-kind', providerOf(agent))
      kind.dataset.kind = agent.kind
      detail.append(kind)
      if (agent.folderName && agent.folderName !== projectName) detail.append(el('span', 'remote-agent-folder', agent.folderName))
      card.append(head, detail)
      return card
    }

    function updateSelection() {
      for (const card of cards.querySelectorAll('[data-agent-shell-id]')) {
        if (card.dataset.agentShellId === current?.agent.shellId) card.setAttribute('aria-current', 'true')
        else card.removeAttribute('aria-current')
      }
    }

    function openChat(agent, draft = '') {
      if (!watching || (current?.agent.shellId === agent.shellId && !current.closed)) return
      if (current) closeChat()
      current = { agent, connected: false, state: 'opening', title: null, hasOlder: false }
      input.value = draft
      updateSelection()
      renderControls()
      send({ type: 'chat-open', shellId: agent.shellId })
    }

    function closeChat(notify = true) {
      if (current && !current.closed && notify) send({ type: 'chat-close', shellId: current.agent.shellId })
      current = null
      updateSelection()
      clearRows()
      input.value = ''
      setNote('')
      renderApproval()
      renderControls()
    }

    function renderControls() {
      const active = current
      const state = active?.state
      const statusName = state === 'ended' ? 'ended' : active?.approval ? 'blocked' : active ? statusOf(active.agent) : 'unknown'
      paneTitle.textContent = active ? active.title || nameOf(active.agent) : ''
      provider.textContent = active ? providerOf(active.agent) : ''
      provider.dataset.kind = active?.agent.kind || ''
      setStatus(status, statusName)
      status.hidden = statusName === 'idle' || statusName === 'working'
      pane.dataset.agentWork = statusName === 'working' ? 'working' : 'idle'
      progress.hidden = !active?.connected || statusName !== 'working'
      const progressText = active?.interrupting ? '중지하는 중…' : '작업 중…'
      if (progress.textContent !== progressText) progress.textContent = progressText
      stop.hidden = !active?.connected || active.agent.kind === 'antigravity' || statusName !== 'working'
      stop.disabled = Boolean(active?.interrupting)
      stop.textContent = stop.disabled ? '중지 중…' : '중지'
      older.hidden = !active?.connected || !active.hasOlder || rows.size >= MAX_ITEMS
      older.disabled = Boolean(active?.loadingOlder)
      older.textContent = older.disabled ? '불러오는 중…' : '이전 대화 더 보기'
      empty.hidden = rows.size > 0
      empty.textContent = state === 'opening' ? '대화를 여는 중…' : state === 'ended' ? '대화가 종료되었습니다.' : '아직 대화가 없습니다.'
      input.readOnly = !active?.connected || state === 'ended' || Boolean(active.sending)
      const canSend = statusName === 'idle' || (statusName === 'working' && active.agent.kind !== 'antigravity')
      submit.disabled = input.readOnly || !canSend || !input.value.trim() || Boolean(draftError(input.value))
      submit.setAttribute('aria-label', active?.sending ? '전송 중…' : '보내기')
    }

    function draftError(text) {
      const first = text.trimStart()[0]
      if (first === '/' || first === '!') return '휴대폰에서는 슬래시 명령과 !로 시작하는 셸 입력을 보낼 수 없습니다.'
      return ''
    }

    function sendChat(event) {
      event.preventDefault()
      const text = input.value.replace(/^\n+/, '').trimEnd()
      const error = draftError(text)
      if (error) return setNote(error, true)
      if (!text.trim() || text.length > MAX_TEXT || submit.disabled) return
      const requestId = String(++nextRequest)
      current.sending = requestId
      setNote('')
      renderControls()
      send({ type: 'chat-send', shellId: current.agent.shellId, requestId, text })
    }

    function interrupt() {
      if (stop.hidden || stop.disabled) return
      current.interrupting = true
      renderControls()
      send({ type: 'chat-interrupt', shellId: current.agent.shellId })
    }

    function requestOlder() {
      if (older.hidden || older.disabled) return
      current.loadingOlder = true
      renderControls()
      send({ type: 'chat-older', shellId: current.agent.shellId })
    }

    function clearRows() {
      rows.clear()
      turns.replaceChildren()
    }

    function setUsageLine(row, text) {
      const label = row.lastElementChild
      if (label?.className === 'remote-chat-usage') {
        if (!text) label.remove()
        else if (label.textContent !== text) label.textContent = text
      } else if (text) row.append(el('p', 'remote-chat-usage', text))
    }

    function updateTurnUsage() {
      // Older pages are prepended. Walk the visible order rather than the Map's insertion order.
      let previous = null
      let usage = ''
      for (const row of turns.children) {
        const entry = rows.get(row.dataset.id)
        if (previous) setUsageLine(previous, entry.startsTurn ? usage : '')
        if (entry.startsTurn) usage = entry.usage
        previous = row
      }
      if (previous) setUsageLine(previous, usage)
    }

    function updateRows(frame) {
      const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60
      const before = scroll.scrollHeight
      const top = scroll.scrollTop
      if (frame.reset) clearRows()
      const items = Array.isArray(frame.items) ? frame.items : []
      const fresh = new Map()
      for (const item of items) {
        if (typeof item?.id !== 'string') continue
        const old = rows.get(item.id)
        const content = chatContent(item, old?.row.querySelector('details')?.open === true)
        if (!content) continue
        const row = el('div', 'remote-chat-row')
        row.dataset.id = item.id
        row.append(content)
        const startsTurn = item.kind === 'user'
        const entry = { row, startsTurn, usage: startsTurn ? turnUsageText(item.usage) : '' }
        if (old) {
          old.row.replaceWith(row)
          rows.set(item.id, entry)
        } else fresh.set(item.id, entry)
      }
      const available = frame.older ? MAX_ITEMS - rows.size : MAX_ITEMS
      const fragment = document.createDocumentFragment()
      for (const [id, entry] of [...fresh].slice(fresh.size - Math.min(available, fresh.size))) {
        rows.set(id, entry)
        fragment.append(entry.row)
      }
      if (frame.older) turns.prepend(fragment)
      else turns.append(fragment)
      while (rows.size > MAX_ITEMS) {
        const first = turns.firstElementChild
        rows.delete(first.dataset.id)
        first.remove()
      }
      updateTurnUsage()
      renderControls()
      if (frame.older) scroll.scrollTop = top + scroll.scrollHeight - before
      else if (frame.reset || atBottom) scroll.scrollTop = scroll.scrollHeight
    }

    function armApproval() {
      clearTimeout(armTimer)
      armTimer = null
      const active = current
      if (!active) return
      const buttons = [...approvalCard.querySelectorAll('button')]
      buttons.forEach(node => { node.disabled = true })
      active.armAt = Infinity
      const signature = active.approval?.signature
      if (!buttons.length || document.hidden || chat.hidden) return
      active.armAt = performance.now() + ARM_MS
      armTimer = setTimeout(() => {
        if (current === active && active.approval?.signature === signature) updateApprovalButtons()
      }, ARM_MS)
    }

    function updateApprovalButtons() {
      const active = current
      const enabled = active?.connected && !active.answering && active.answered !== active.approval?.signature
        && !document.hidden && !chat.hidden && performance.now() >= active.armAt
      for (const node of approvalCard.querySelectorAll('button')) node.disabled = !enabled || node.dataset.phoneBlocked === 'true'
    }

    function renderApproval() {
      const request = current?.approval
      approvalCard.replaceChildren()
      approvalCard.hidden = !request
      if (request) {
        approvalCard.append(el('strong', 'remote-chat-approval-question', request.question || '에이전트가 확인을 기다리고 있습니다.'))
        if (Array.isArray(request.detail) && request.detail.length) {
          approvalCard.append(el('pre', 'remote-chat-approval-detail', request.detail.join('\n')))
        }
        const options = Array.isArray(request.options) ? request.options.filter(option => /^[1-9]$/.test(option?.key)) : []
        if (current.agent.kind === 'antigravity' || request.usesTerminalInput || request.terminalOnly || !options.length || typeof request.signature !== 'string') {
          approvalCard.append(el('p', 'remote-chat-note', '이 확인 요청은 PC의 터미널에서 응답해 주세요.'))
        } else {
          const choices = el('div', 'remote-chat-choices')
          for (const option of options) {
            const phoneBlocked = option.phoneBlocked === true
            const choice = button('', 'remote-chat-approval-option', () => {
              if (!phoneBlocked) answer(option.key, request.signature)
            })
            choice.append(el('span', 'remote-chat-approval-key', option.key), el('span', 'remote-chat-approval-label', option.label))
            if (phoneBlocked) {
              choice.dataset.phoneBlocked = 'true'
              choice.append(el('span', 'remote-chat-approval-pc-only', 'PC에서만'))
            }
            choices.append(choice)
          }
          approvalCard.append(choices)
        }
      }
      armApproval()
    }

    function answer(key, signature) {
      if (!current?.connected || current.approval?.signature !== signature || current.answering || current.answered === signature
        || document.hidden || chat.hidden || performance.now() < current.armAt) return
      current.answering = signature
      updateApprovalButtons()
      send({ type: 'chat-answer', shellId: current.agent.shellId, key, signature })
    }

    function endChat(message, notify = true) {
      if (!current.closed && notify) send({ type: 'chat-close', shellId: current.agent.shellId })
      Object.assign(current, { closed: true, connected: false, state: 'ended', approval: null, sending: null })
      renderApproval()
      setNote(message, true)
      renderControls()
    }

    function frame(msg) {
      if (msg.gone) return endChat('PC에서 에이전트 세션이 닫혔습니다.')
      if (msg.kind && msg.kind !== current.agent.kind) return endChat(AGENT_CHANGED)
      if (msg.title !== undefined) current.title = msg.title
      if (msg.hasOlder !== undefined) current.hasOlder = msg.hasOlder
      if (msg.approval !== undefined && (Boolean(msg.approval) !== Boolean(current.approval)
        || msg.approval?.signature !== current.approval?.signature)) {
        current.approval = msg.approval
        current.answered = null
        renderApproval()
      }
      if (msg.state !== undefined) current.state = msg.state
      if (msg.state === 'ended') endChat('에이전트가 종료되었습니다.')
      if (msg.items || msg.reset) updateRows(msg)
      else renderControls()
    }

    function requestList() {
      send({ type: 'agents-list' })
      send({ type: 'agents-watch', on: true })
    }

    function showListError(message) {
      listError = message
      agents = []
      renderList()
      if (current) {
        clearRows()
        input.value = ''
        endChat(message, false)
      }
    }

    function onMessage(msg) {
      if (msg.type === 'features') {
        if (!watching) return
        if (msg.features?.agents === false && !listError) showListError(ACCESS_OFF)
        if (msg.features?.agents === true && listError) {
          listError = ''
          agents = null
          renderList()
          requestList()
        }
        return
      }
      if (msg.type === 'agents') {
        if (!watching) return
        if (typeof msg.error === 'string' && msg.error) return showListError(msg.error)
        listError = ''
        agents = Array.isArray(msg.agents) ? msg.agents.filter(agent => typeof agent?.shellId === 'string') : []
        renderList()
        if (current && !current.closed) {
          const active = agents.find(agent => agent.shellId === current.agent.shellId
            && agent.agentId === current.agent.agentId && agent.kind === current.agent.kind)
          if (!active) return endChat(AGENT_CHANGED)
          current.agent = active
          renderControls()
        }
        return
      }
      if (!current || current.closed || msg.shellId !== current.agent.shellId) return
      switch (msg.type) {
        case 'chat-frame':
          return frame(msg)
        case 'chat-opened':
          if (!msg.ok) return endChat(msg.error || '대화를 열지 못했습니다.')
          current.connected = true
          if (current.state === 'opening') current.state = 'waiting'
          updateApprovalButtons()
          break
        case 'chat-older-result':
          current.loadingOlder = false
          if (!msg.ok) setNote(msg.error || '이전 대화를 불러오지 못했습니다.', true)
          break
        case 'chat-send-result':
          if (!current.sending || current.sending !== msg.requestId) return
          if (msg.ok) input.value = ''
          current.sending = null
          setNote(msg.ok ? '보냈습니다.' : msg.error || '메시지를 보내지 못했습니다.', !msg.ok)
          break
        case 'chat-answer-result': {
          const signature = current.answering
          current.answering = null
          if (signature && signature === current.approval?.signature) {
            if (msg.ok) current.answered = signature
            setNote(msg.ok ? '응답을 보냈습니다.' : msg.error || '응답을 보내지 못했습니다.', !msg.ok)
          }
          updateApprovalButtons()
          break
        }
        case 'chat-interrupt-result':
          current.interrupting = false
          setNote(msg.ok ? '중지를 요청했습니다.' : msg.error || '중지하지 못했습니다.', !msg.ok)
          break
      }
      renderControls()
    }

    function reset(notify = false, keepReviews = false) {
      watching = false
      agents = null
      if (!keepReviews) reviewTabs = []
      listError = ''
      cards.replaceChildren()
      closeChat(notify)
      if (reviewTabs.length) renderList()
    }

    closeChat(false)
    return {
      get isOpen() { return Boolean(current && !current.closed) },
      get draft() { return current?.sending ? '' : input.value },
      get hasReviewTabs() { return reviewTabs.length > 0 },
      nameOf,
      setTabStatus(dot, agent, unavailable) {
        const status = unavailable ? 'ended' : statusOf(agent)
        dot.dataset.status = status
        dot.setAttribute('role', 'img')
        dot.setAttribute('aria-label', STATUSES[status])
        dot.title = STATUSES[status]
      },
      setReviewTabs(tabs) {
        reviewTabs = Array.isArray(tabs) ? tabs.filter(tab => tab?.kind === 'browser' && typeof tab.id === 'string') : []
        renderList()
      },
      reopen: openChat,
      enter() {
        if (watching) return
        watching = true
        renderList()
        requestList()
      },
      leave() {
        if (!watching) return
        send({ type: 'agents-watch', on: false })
        reset(true, true)
      },
      closeChat,
      reset,
      onMessage
    }
  }
})()
