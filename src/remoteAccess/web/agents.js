// Read and control the PC's agent chat from the phone. Server text is always added as DOM text.
(() => {
  'use strict'
  const ns = (window.ezRemote = window.ezRemote || {})
  const MAX_TEXT = 16_000
  const MAX_ITEMS = 3000
  const ARM_MS = 800
  const ACCESS_OFF = '휴대폰에서 에이전트 쓰기가 꺼져 있습니다. PC 설정의 원격 접속에서 켜 주세요.'
  const AGENT_CHANGED = 'PC에서 에이전트 세션이 바뀌었습니다.'
  const PROVIDERS = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }
  const STATUSES = {
    idle: '쉬는 중', working: '작업 중', blocked: '확인 대기', starting: '시작 중',
    sleeping: '잠듦', ended: '종료됨', error: '오류', unknown: '상태 확인 중'
  }

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
  const nameOf = agent => agent.role ? `${agent.role} · ${agent.agentId}` : agent.name || agent.agentId || '에이전트'

  function setStatus(node, status) {
    node.dataset.status = status
    node.textContent = STATUSES[status]
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

  function chatRow(item, expanded) {
    const text = typeof item.text === 'string' ? item.text : ''
    if (item.kind === 'user') return el('div', 'remote-chat-user', text || (item.hasImage ? '이미지 첨부' : ''))
    if (item.kind === 'assistant') {
      const answer = el('div', 'remote-chat-answer')
      appendAnswer(answer, text)
      return answer
    }
    if (item.kind === 'notice') return el('p', 'remote-chat-notice', text)
    const tool = item.tool
    const label = item.kind === 'thinking' ? '생각' : item.kind === 'output' ? item.outputCommand || '출력'
      : item.kind === 'tool' && tool ? [tool.name || '도구', tool.summary].filter(Boolean).join(' · ') : ''
    if (!label) return null
    const details = el('details', 'remote-chat-detail')
    details.open = expanded
    const failed = item.isError || tool?.isError
    details.append(el('summary', '', failed ? `${label} · 오류` : label))
    const parts = tool ? [tool.input, tool.result, Array.isArray(tool.diff) ? tool.diff.join('\n') : ''] : [text]
    for (const part of parts) {
      if (typeof part === 'string' && part) details.append(el('pre', '', part))
    }
    return details
  }

  ns.createAgents = function createAgents({ list, chat, send, show }) {
    let watching = false
    let agents = null
    let listError = ''
    let current = null
    let nextRequest = 0
    let armTimer = null
    const rows = new Map()

    chat.classList.add('remote-chat-view')
    const listBar = el('header', 'bar')
    const listHeading = el('strong', '')
    listHeading.append(el('span', 'compact-heading', '에이전트'), el('span', 'workspace-heading', '로컬 작업'))
    listBar.append(listHeading)
    const cards = el('div', 'list remote-agent-cards')
    list.replaceChildren(listBar, cards)

    const chatBar = el('header', 'bar remote-chat-bar')
    const back = button('', 'ghost workspace-return', () => {
      show('agents')
      cards.querySelector('button')?.focus({ preventScroll: true })
    })
    const closeMark = el('span', '', '×')
    closeMark.setAttribute('aria-hidden', 'true')
    back.append(el('span', '', '‹ 목록'), closeMark)
    back.setAttribute('aria-label', '에이전트 목록으로')
    const title = el('strong', 'remote-chat-title')
    const stop = button('중지', 'remote-chat-stop', interrupt)
    chatBar.append(back, title)
    const meta = el('div', 'remote-chat-meta')
    const provider = el('span', 'remote-agent-kind')
    const status = el('span', 'remote-agent-status')
    const paneTitle = el('strong', 'remote-chat-pane-title')
    meta.append(provider, status, paneTitle)
    chatBar.append(stop)

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
    const input = el('textarea', 'remote-chat-input')
    input.rows = 2
    input.maxLength = MAX_TEXT
    input.setAttribute('aria-label', '에이전트에게 보낼 글')
    input.placeholder = '에이전트에게 보낼 글'
    const submit = el('button', 'primary remote-chat-send')
    submit.type = 'submit'
    const submitText = el('span', 'compact-heading', '보내기')
    const sendIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    sendIcon.setAttribute('class', 'workspace-heading send-glyph')
    sendIcon.setAttribute('aria-hidden', 'true')
    sendIcon.setAttribute('viewBox', '0 0 24 24')
    const sendPath = document.createElementNS(sendIcon.namespaceURI, 'path')
    // Remix Icon RiSendPlane2Line, also used by AgentChatCover.
    sendPath.setAttribute('d', 'M3.5 1.34558C3.58425 1.34558 3.66714 1.36687 3.74096 1.40747L22.2034 11.5618C22.4454 11.6949 22.5337 11.9989 22.4006 12.2409C22.3549 12.324 22.2865 12.3924 22.2034 12.4381L3.74096 22.5924C3.499 22.7255 3.19497 22.6372 3.06189 22.3953C3.02129 22.3214 3 22.2386 3 22.1543V1.84558C3 1.56944 3.22386 1.34558 3.5 1.34558ZM5 4.38249V10.9999H10V12.9999H5V19.6174L18.8499 11.9999L5 4.38249Z')
    sendIcon.append(sendPath)
    submit.append(submitText, sendIcon)
    const composer = el('div', 'remote-chat-composer')
    composer.append(input, submit)
    form.append(note, composer)
    form.addEventListener('submit', sendChat)
    input.addEventListener('input', () => {
      setNote(draftError(input.value), true)
      renderControls()
    })
    chat.replaceChildren(chatBar, meta, scroll, approvalCard, form)
    document.addEventListener('visibilitychange', armApproval)

    function setNote(text, error = false) {
      note.textContent = text
      note.hidden = !text
      note.classList.toggle('is-error', error)
    }

    function renderList() {
      const focusedId = cards.contains(document.activeElement) ? document.activeElement.dataset.agentShellId : null
      cards.replaceChildren()
      if (listError) {
        const message = el('p', 'error', listError)
        message.setAttribute('role', 'status')
        cards.append(message)
        return
      }
      if (!agents?.length) {
        cards.append(el('p', 'empty', agents ? '실행 중인 에이전트가 없습니다.' : '에이전트 목록을 불러오는 중…'))
        return
      }
      const fragment = document.createDocumentFragment()
      let focusedCard = null
      for (const agent of agents) {
        const card = button('', 'remote-agent-card', () => openChat(agent))
        card.dataset.agentShellId = agent.shellId
        if (agent.shellId === focusedId) focusedCard = card
        if (current?.agent.shellId === agent.shellId) card.setAttribute('aria-current', 'true')
        const head = el('span', 'remote-agent-card-head')
        const glyph = el('span', 'terminal-glyph', '>_')
        glyph.setAttribute('aria-hidden', 'true')
        const badge = el('span', 'remote-agent-status')
        setStatus(badge, statusOf(agent))
        head.append(glyph, el('strong', 'remote-agent-name', nameOf(agent)), badge)
        const detail = el('span', 'remote-agent-card-meta')
        const kind = el('span', 'remote-agent-kind', providerOf(agent))
        kind.dataset.kind = agent.kind
        detail.append(kind)
        if (agent.folderName) detail.append(el('span', 'remote-agent-folder', agent.folderName))
        card.append(head, detail)
        fragment.append(card)
      }
      cards.append(fragment)
      focusedCard?.focus({ preventScroll: true })
    }

    function updateSelection() {
      for (const card of cards.querySelectorAll('[data-agent-shell-id]')) {
        if (card.dataset.agentShellId === current?.agent.shellId) card.setAttribute('aria-current', 'true')
        else card.removeAttribute('aria-current')
      }
    }

    function openChat(agent) {
      if (!watching || (current?.agent.shellId === agent.shellId && !current.closed)) return
      if (current) closeChat()
      current = { agent, connected: false, state: 'opening', title: null, hasOlder: false }
      updateSelection()
      renderControls()
      show('chat')
      if (list.hidden) back.focus({ preventScroll: true })
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
      title.textContent = active ? active.title || nameOf(active.agent) : ''
      paneTitle.textContent = title.textContent
      provider.textContent = active ? providerOf(active.agent) : ''
      provider.dataset.kind = active?.agent.kind || ''
      setStatus(status, statusName)
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
      submitText.textContent = active?.sending ? '전송 중…' : '보내기'
      submit.setAttribute('aria-label', submitText.textContent)
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
        const row = chatRow(item, old?.open === true)
        if (!row) continue
        row.dataset.id = item.id
        if (old) {
          old.replaceWith(row)
          rows.set(item.id, row)
        } else fresh.set(item.id, row)
      }
      const available = frame.older ? MAX_ITEMS - rows.size : MAX_ITEMS
      const fragment = document.createDocumentFragment()
      for (const [id, row] of [...fresh].slice(fresh.size - Math.min(available, fresh.size))) {
        rows.set(id, row)
        fragment.append(row)
      }
      if (frame.older) turns.prepend(fragment)
      else turns.append(fragment)
      while (rows.size > MAX_ITEMS) {
        const first = turns.firstElementChild
        rows.delete(first.dataset.id)
        first.remove()
      }
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
      for (const node of approvalCard.querySelectorAll('button')) node.disabled = !enabled
    }

    function renderApproval() {
      const request = current?.approval
      approvalCard.replaceChildren()
      approvalCard.hidden = !request
      if (request) {
        approvalCard.append(el('strong', '', request.question || '에이전트가 확인을 기다리고 있습니다.'))
        if (request.detail?.length && Array.isArray(request.detail)) approvalCard.append(el('pre', '', request.detail.join('\n')))
        const options = Array.isArray(request.options) ? request.options.filter(option => /^[1-9]$/.test(option?.key)) : []
        if (current.agent.kind === 'antigravity' || request.usesTerminalInput || !options.length || typeof request.signature !== 'string') {
          approvalCard.append(el('p', 'remote-chat-note', '이 확인 요청은 PC의 터미널에서 응답해 주세요.'))
        } else {
          const choices = el('div', 'remote-chat-choices')
          for (const option of options) {
            choices.append(button(`${option.key} ${option.label}`, '', () => answer(option.key, request.signature)))
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
          if (current) {
            closeChat(false)
            show('agents')
          }
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

    function reset(notify = false) {
      watching = false
      agents = null
      listError = ''
      cards.replaceChildren()
      closeChat(notify)
    }

    closeChat(false)
    return {
      layout(workspace) {
        const parent = workspace ? meta : chatBar
        if (stop.parentElement !== parent) parent.append(stop)
      },
      enter() {
        if (watching) return
        watching = true
        renderList()
        requestList()
      },
      leave() {
        if (!watching) return
        send({ type: 'agents-watch', on: false })
        reset(true)
      },
      closeChat,
      reset,
      onMessage
    }
  }
})()
