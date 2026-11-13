// "May Claude do this?" on the phone: the same request the PC's approval dialog shows, as a card over
// whatever screen is open. Same fields and wording as McpApprovalDialog.tsx; the command is shown as
// it was sent (no layout). The buttons wait 0.8s after the card is on screen (and after the page
// comes back into view), and a file change has to be scrolled to its end before it can be allowed.
// Plain script (no build step); server text goes in as textContent only.
(() => {
  'use strict'
  const ns = (window.ezRemote = window.ezRemote || {})

  const ARM_MS = 800
  const TICK_MS = 250
  const RISK_LABELS = { low: '낮음', medium: '중간', danger: '위험', forbidden: '차단' }
  const DIRECTION_LABELS = { upload: 'PC → 서버 (올리기)', download: '서버 → PC (내려받기)' }
  const COMMAND_HINT = 'Claude Code 가 요청한 명령입니다. 내용을 확인한 뒤 허용하세요. 응답하지 않으면 시간이 지나 자동으로 거부됩니다.'
  const FILE_HINT = 'Claude Code 가 요청한 파일 변경입니다. 허용하면 위 내용 그대로 서버의 파일에 씁니다. 응답하지 않으면 시간이 지나 자동으로 거부됩니다.'
  const TRANSFER_HINT = 'Claude Code 가 요청한 파일 전송입니다. 양쪽 경로와 방향을 확인한 뒤 허용하세요. 파일 내용은 여기에 표시되지 않습니다. 응답하지 않으면 시간이 지나 자동으로 거부됩니다.'
  const NO_CHANGE_HINT = 'Claude Code 가 보낸 내용이 지금 파일과 같습니다. 허용하면 파일은 그대로 두고, 내용이 같다는 사실만 알려 줍니다.'
  const PURPOSE_NOTE = 'Claude Code 가 직접 적은 설명입니다. 실제 명령과 다를 수 있으니 아래 명령을 기준으로 판단하세요.'
  const CLOSED_NOTES = {
    pc: 'PC 에서 답했습니다.',
    approved: '허용되었습니다.',
    denied: '거부되었습니다.',
    expired: '시간이 지나 거부되었습니다.',
    cancelled: '요청이 취소되었습니다.'
  }

  // Same set as src/renderer/lib/mcpLabels.ts: invisible, look-alike and layout-changing characters
  const HIDDEN_CHARS = new RegExp(
    '[' +
    '\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F' +
    '\\u00AD\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180E\\u200B-\\u200D\\u2060-\\u2064\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF9-\\uFFFB' +
    '\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}' +
    '\\u061C\\u200E\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u206F' +
    '\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u2800\\u3000' +
    ']',
    'gu'
  )
  const token = (char) => `⟨U+${(char.codePointAt(0) || 0).toString(16).toUpperCase().padStart(4, '0')}⟩`

  function reveal(text) {
    let hasHidden = false
    const shown = String(text ?? '').replace(HIDDEN_CHARS, (char) => {
      hasHidden = true
      return token(char)
    })
    return { text: shown, hasHidden }
  }

  /** A path is one line: a line break, a tab or a blank at either end is as suspicious as a hidden character */
  function revealPath(path) {
    const revealed = reveal(path)
    const text = revealed.text.replace(/[\n\t]/g, token).replace(/^ +| +$/g, (blanks) => token(' ').repeat(blanks.length))
    return { text, hasHidden: revealed.hasHidden || text !== revealed.text }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0}B`
    const units = ['KB', 'MB', 'GB']
    let value = bytes / 1024
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit += 1
    }
    return `${value.toFixed(1)}${units[unit]}`
  }

  /** dt/dd rows; `hidden` collects whether anything shown had a hidden character */
  function field(list, label, ...content) {
    list.append(el('dt', '', label))
    const dd = el('dd')
    dd.append(...content.filter(Boolean))
    list.append(dd)
    return dd
  }

  const code = (text, className = '') => el('code', className, text)
  const sub = (text) => el('div', 'approval-sub', text)

  function pathField(list, label, path, requested, receiving, flag) {
    const shown = revealPath(path)
    if (shown.hasHidden) flag()
    const dd = field(list, label, code(shown.text, 'approval-path'))
    if (receiving) dd.append(el('span', 'approval-folder', ` · ${receiving}`))
    if (requested && requested !== path) {
      const asked = revealPath(requested)
      if (asked.hasHidden) flag()
      const line = sub('요청 경로: ')
      line.append(code(asked.text, 'approval-path'))
      dd.append(line)
    }
  }

  function diffView(hunks, flag) {
    const box = el('div', 'approval-diff')
    box.tabIndex = 0
    box.setAttribute('aria-label', '변경 내용')
    for (const hunk of hunks) {
      box.append(el('div', 'diff-header', reveal(hunk.header).text))
      for (const line of hunk.lines || []) {
        const revealed = reveal(line.text)
        if (revealed.hasHidden) flag()
        const mark = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : line.type === 'note' ? '' : ' '
        box.append(el('div', `diff-line is-${line.type}`, `${mark}${revealed.text}`))
      }
    }
    return box
  }

  /**
   * @param {{ send: (message: object) => void }} options
   */
  ns.createApprovals = function createApprovals({ send }) {
    const layer = el('div', 'approval-layer')
    layer.hidden = true
    layer.setAttribute('role', 'dialog')
    layer.setAttribute('aria-modal', 'true')
    layer.setAttribute('aria-label', 'MCP 확인 요청')
    const toast = el('div', 'approval-toast')
    toast.hidden = true
    toast.setAttribute('role', 'status')
    document.body.append(layer, toast)

    let current = null
    let queue = []
    let timer = 0
    let toastTimer = 0
    let visibleAt = document.visibilityState === 'visible' ? Date.now() : Infinity

    document.addEventListener('visibilitychange', () => {
      // Back on screen: the buttons wait again, so a tap meant for something else does not answer
      visibleAt = document.visibilityState === 'visible' ? Date.now() : Infinity
      refresh()
    })

    function showToast(text) {
      toast.textContent = text
      toast.hidden = false
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => { toast.hidden = true }, 3000)
    }

    function build(request) {
      const isFile = request.kind === 'file'
      const isTransfer = request.kind === 'transfer'
      const hunks = isFile && Array.isArray(request.hunks) ? request.hunks : []
      let hasHidden = false
      const flag = () => { hasHidden = true }
      let commandBox = null

      const card = el('section', `approval-card risk-${RISK_LABELS[request.level] ? request.level : 'danger'}`)
      const head = el('div', 'approval-head')
      const title = el('h2', '', isTransfer ? 'MCP 파일 전송 요청' : isFile ? 'MCP 파일 쓰기 요청' : 'MCP 명령 실행 요청')
      const remaining = el('span', 'approval-timer')
      head.append(title, remaining)

      const list = el('dl', 'approval-fields')
      const session = field(list, '세션', document.createTextNode(String(request.sessionName ?? '')))
      if (request.folder) session.append(el('span', 'approval-folder', ` (${request.folder})`))

      if (isTransfer) {
        const isUpload = request.direction === 'upload'
        const receiving = request.isNew ? '새 파일' : '기존 파일 덮어쓰기'
        field(list, '방향', document.createTextNode(DIRECTION_LABELS[isUpload ? 'upload' : 'download']))
        pathField(list, 'PC 파일', request.localPath, request.requestedLocalPath, isUpload ? null : receiving, flag)
        pathField(list, '서버 파일', request.remotePath, request.requestedRemotePath, isUpload ? receiving : null, flag)
        const size = Number(request.size) || 0
        const dd = field(list, '크기', document.createTextNode(`${formatBytes(size)} `))
        dd.append(el('span', 'approval-folder', `(${size.toLocaleString('ko-KR')}바이트)`))
      } else if (isFile) {
        pathField(list, '파일', request.path, request.requestedPath, null, flag)
        const kind = request.noChange ? '변경 없음' : request.isNew ? '새 파일' : '기존 파일 수정'
        const dd = field(list, '변경', document.createTextNode(kind))
        if (!request.noChange) {
          dd.append(el('span', 'diff-stat is-add', ` +${request.added ?? 0}줄`), el('span', 'diff-stat is-remove', ` -${request.removed ?? 0}줄`))
        }
        if (request.isWholeFile) dd.append(sub('바뀐 곳이 많아 파일 전체를 지우고 새로 쓰는 것으로 표시합니다.'))
      } else {
        if (request.purpose) {
          const purpose = reveal(request.purpose)
          if (purpose.hasHidden) flag()
          field(list, '요청 사유', el('p', 'approval-purpose', purpose.text), sub(PURPOSE_NOTE))
        }
        const cwd = request.cwd === null || request.cwd === undefined ? null : reveal(request.cwd)
        if (cwd && cwd.hasHidden) flag()
        field(list, '위치', code(cwd ? cwd.text : '알 수 없음'))
        const command = reveal(request.command)
        if (command.hasHidden) flag()
        commandBox = el('pre', 'approval-command', command.text)
        commandBox.tabIndex = 0
        field(list, '명령', commandBox)
        if (request.background) {
          field(list, '실행 방식', document.createTextNode(`백그라운드 실행 · 최대 ${request.background.limitMinutes}분`),
            sub('허용하면 끝날 때까지 서버에서 계속 실행됩니다. MCP 활동에서 중지할 수 있고, PC 의 앱을 잠그면 함께 중지됩니다.'))
        }
      }

      const risk = el('span', `risk-badge risk-${RISK_LABELS[request.level] ? request.level : 'danger'}`, RISK_LABELS[request.level] || String(request.level ?? ''))
      const riskDd = field(list, '위험도', risk)
      const reasons = Array.isArray(request.reasons) ? request.reasons : []
      if (reasons.length > 0) {
        const ul = el('ul', 'approval-reasons')
        for (const reason of reasons) {
          const shown = reveal(reason)
          if (shown.hasHidden) flag()
          ul.append(el('li', '', shown.text))
        }
        riskDd.append(ul)
      }

      card.append(head, list)
      const diff = hunks.length > 0 ? diffView(hunks, flag) : null
      if (diff) card.append(diff)
      if (hasHidden) {
        const thing = isTransfer ? '경로를' : isFile ? '변경 내용을' : '명령을'
        card.append(el('p', 'approval-warning', `보이지 않는 문자가 포함되어 있습니다. ${thing} 꼼꼼히 확인하세요.`))
      }
      card.append(el('p', 'approval-hint', isTransfer ? TRANSFER_HINT : isFile ? (request.noChange ? NO_CHANGE_HINT : FILE_HINT) : COMMAND_HINT))
      const note = el('p', 'approval-note')
      card.append(note)
      // Stacked, far apart: 거부 at the bottom where the thumb rests, 허용 above it (see app.css)
      const actions = el('div', 'approval-actions')
      const deny = el('button', 'approval-deny', '거부')
      const allow = el('button', 'approval-allow', '허용')
      deny.type = 'button'
      allow.type = 'button'
      actions.append(allow, deny)
      card.append(actions)
      // What has to be scrolled to its end before 허용: the change, or a command too long for its box
      const mustRead = diff ? { box: diff, note: '변경 내용을 끝까지 내려 본 뒤에 허용할 수 있습니다.' }
        : commandBox ? { box: commandBox, note: '명령이 길어 다 보이지 않습니다. 명령 상자를 끝까지 내려 본 뒤에 허용할 수 있습니다.' }
          : null
      return { card, mustRead, remaining, note, deny, allow }
    }

    function show(request) {
      const receivedAt = Date.now()
      const deadline = Number.isFinite(request.remainingMs) ? receivedAt + request.remainingMs : Number(request.expiresAt) || receivedAt
      const parts = build(request)
      current = { request, deadline, shownAt: Date.now(), seenEnd: !parts.mustRead, state: 'open', message: '', ...parts }
      parts.deny.addEventListener('click', () => respond(false))
      parts.allow.addEventListener('click', () => respond(true))
      if (parts.mustRead) {
        const { box } = parts.mustRead
        const shown = current
        const check = () => {
          if (current !== shown || shown.seenEnd) return
          // Fits in its box (nothing to scroll), or scrolled to the end
          if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) {
            shown.seenEnd = true
            refresh()
          }
        }
        box.addEventListener('scroll', check, { passive: true })
        // Measured once it is laid out: a command or change short enough to fit has been seen whole
        requestAnimationFrame(check)
      }
      layer.textContent = ''
      layer.append(parts.card)
      layer.hidden = false
      layer.scrollTop = 0
      clearInterval(timer)
      timer = setInterval(refresh, TICK_MS)
      refresh()
    }

    function refresh() {
      if (!current) return
      const now = Date.now()
      const left = Math.max(0, Math.ceil((current.deadline - now) / 1000))
      current.remaining.textContent = left > 0 ? `남은 시간 ${left}초` : '시간 지남'
      const armed = now >= Math.max(current.shownAt, visibleAt) + ARM_MS
      const isOpen = current.state === 'open' && left > 0
      current.deny.disabled = !(isOpen && armed)
      current.allow.disabled = !(isOpen && armed && current.seenEnd)
      let note = current.message
      if (!note && !current.seenEnd) note = current.mustRead.note
      if (!note && left === 0) note = '시간이 지났습니다. PC 의 결과를 기다리는 중…'
      current.note.textContent = note
      current.note.hidden = !note
    }

    function respond(approved) {
      if (!current || current.state !== 'open') return
      current.state = 'sending'
      current.message = approved ? '허용을 보내는 중…' : '거부를 보내는 중…'
      send({ type: 'approval-respond', id: current.request.id, approved })
      refresh()
    }

    function hide() {
      clearInterval(timer)
      current = null
      layer.hidden = true
      layer.textContent = ''
      const next = queue.shift()
      if (next) show(next)
    }

    return {
      /** A request started (also each one in `ready.approvals`) */
      add(request) {
        if (!request || typeof request.id !== 'string') return
        if (current && current.request.id === request.id) return
        if (queue.some((r) => r.id === request.id)) return
        if (current) queue.push(request)
        else show(request)
      },
      /** The request ended, whoever answered */
      closed({ id, outcome, by }) {
        queue = queue.filter((r) => r.id !== id)
        if (!current || current.request.id !== id) return
        const answeredHere = current.state === 'sending' || current.state === 'sent'
        hide()
        if (by === 'pc') showToast(CLOSED_NOTES.pc)
        else if (!answeredHere || outcome === 'expired' || outcome === 'cancelled') showToast(CLOSED_NOTES[outcome] || '요청이 끝났습니다.')
        else showToast(CLOSED_NOTES[outcome] || '답을 보냈습니다.')
      },
      /** What happened to this device's answer */
      result({ id, ok, message }) {
        if (!current || current.request.id !== id) return
        if (ok) {
          current.state = 'sent'
          current.message = '보냈습니다.'
        } else {
          // The server also keeps the 0.8s rule; a request that already ended is closed by approval-closed
          current.state = 'open'
          current.message = message || '이미 끝난 요청입니다.'
        }
        refresh()
      },
      /** The connection ended: nothing can be answered any more */
      reset() {
        queue = []
        if (current) hide()
      }
    }
  }
})()
