// MCP activity on the phone: the requests Claude Code made, in time order, each with its state,
// command and what it printed (like the PC panel's terminal view). A running request can be stopped.
// Kept in memory only while the page is open; the server sends updates only while this screen is
// shown (activity-watch). Plain script (no build step); server text goes in as textContent only.
(() => {
  'use strict'
  const ns = (window.ezRemote = window.ezRemote || {})

  const MAX_ITEMS = 100
  /** Output kept per request on the phone (the server sends the last 16KB) */
  const MAX_OUTPUT_CHARS = 16 * 1024
  const STATE_LABELS = {
    waiting: '확인 대기',
    running: '실행 중',
    done: '완료',
    timeout: '시간 초과',
    denied: '거부',
    expired: '만료',
    cancelled: '취소',
    blocked: '차단',
    failed: '실패'
  }
  const RISK_LABELS = { low: '낮음', medium: '중간', danger: '위험', forbidden: '차단' }
  const STOPPABLE = new Set(['running'])

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function clockOf(item) {
    const date = new Date(Number(item.startedAt) || item.time)
    if (Number.isNaN(date.getTime())) return ''
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  /** Keeps the end of the output within MAX_OUTPUT_CHARS */
  function trimParts(parts) {
    let total = 0
    const kept = []
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]
      const text = String(part.text ?? '')
      if (total + text.length > MAX_OUTPUT_CHARS) {
        kept.unshift({ stream: part.stream, text: text.slice(text.length - (MAX_OUTPUT_CHARS - total)) })
        return { parts: kept, trimmed: true }
      }
      total += text.length
      kept.unshift({ stream: part.stream, text })
    }
    return { parts: kept, trimmed: false }
  }

  /**
   * @param {{ list: HTMLElement, send: (message: object) => void }} options
   */
  ns.createActivity = function createActivity({ list, send }) {
    let items = []
    let isWatching = false
    // Requests whose stop was asked and not answered yet
    const stopping = new Set()
    const notes = new Map()

    const isNearEnd = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60

    function blockFor(item) {
      const block = el('article', `act-item is-${STATE_LABELS[item.state] ? item.state : 'done'}`)
      block.dataset.id = item.id
      const head = el('div', 'act-head')
      head.append(
        el('span', 'act-time', clockOf(item)),
        el('span', 'act-session', String(item.sessionName ?? '')),
        el('span', `act-state is-${STATE_LABELS[item.state] ? item.state : 'done'}`, STATE_LABELS[item.state] || String(item.state ?? ''))
      )
      if (item.level && RISK_LABELS[item.level]) head.append(el('span', `risk-badge risk-${item.level}`, RISK_LABELS[item.level]))
      if (item.background) head.append(el('span', 'act-tag', '백그라운드'))
      if (STOPPABLE.has(item.state)) {
        const stop = el('button', 'act-stop', stopping.has(item.id) ? '중지하는 중…' : '중지')
        stop.type = 'button'
        stop.disabled = stopping.has(item.id)
        stop.addEventListener('click', () => {
          stopping.add(item.id)
          send({ type: 'activity-stop', id: item.id })
          replace(item)
        })
        head.append(stop)
      }
      block.append(head)
      if (item.cwd) block.append(el('div', 'act-cwd', item.cwd))
      block.append(el('pre', 'act-command', `$ ${String(item.command ?? '')}`))

      const parts = Array.isArray(item.outputParts) ? item.outputParts : []
      if (item.outputTrimmed || item.phoneTrimmed) block.append(el('div', 'act-note', '앞부분 출력은 생략했습니다.'))
      if (parts.length > 0) {
        const out = el('pre', 'act-output')
        for (const part of parts) out.append(part.stream === 'stderr' ? el('span', 'is-stderr', part.text) : document.createTextNode(part.text))
        block.append(out)
      } else if (item.output && item.state !== 'running') {
        block.append(el('pre', 'act-output', String(item.output)))
      }
      if (item.transfer && Number(item.transfer.size) > 0) {
        const percent = Math.min(100, Math.round((Number(item.transfer.done) / Number(item.transfer.size)) * 100))
        const bar = el('div', 'act-progress')
        const fill = el('span')
        fill.style.width = `${percent}%`
        bar.append(fill)
        block.append(bar, el('div', 'act-note', `${item.transfer.direction === 'upload' ? '올리는 중' : '내려받는 중'} ${percent}%`))
      }
      const tail = []
      if (item.exitCode !== undefined && item.exitCode !== null) tail.push(`종료 코드 ${item.exitCode}`)
      if (item.timedOut) tail.push('시간 초과로 중단')
      if (item.error) tail.push(String(item.error))
      if (Array.isArray(item.reasons) && item.reasons.length > 0 && (item.state === 'blocked' || item.state === 'denied')) tail.push(item.reasons.join(' · '))
      if (tail.length > 0) block.append(el('div', 'act-result', tail.join(' · ')))
      const note = notes.get(item.id)
      if (note) block.append(el('div', 'act-note is-error', note))
      return block
    }

    function render() {
      const stick = isNearEnd()
      list.textContent = ''
      if (items.length === 0) {
        list.append(el('p', 'empty', 'MCP 요청이 아직 없습니다.'))
        return
      }
      for (const item of items) list.append(blockFor(item))
      if (stick) list.scrollTop = list.scrollHeight
    }

    function replace(item) {
      const stick = isNearEnd()
      const old = list.querySelector(`[data-id="${CSS.escape(item.id)}"]`)
      if (!old) return render()
      old.replaceWith(blockFor(item))
      if (stick) list.scrollTop = list.scrollHeight
    }

    function normalize(item) {
      const parts = Array.isArray(item.outputParts) ? item.outputParts : []
      const { parts: kept, trimmed } = trimParts(parts)
      return { ...item, outputParts: kept, phoneTrimmed: trimmed }
    }

    return {
      /** Entering the screen: ask for the list and for updates */
      enter() {
        if (isWatching) return
        isWatching = true
        send({ type: 'activity-list' })
        send({ type: 'activity-watch', on: true })
        render()
      },
      /** Leaving the screen: no more updates (what was shown is dropped too) */
      leave() {
        if (!isWatching) return
        isWatching = false
        send({ type: 'activity-watch', on: false })
        items = []
        stopping.clear()
        notes.clear()
        list.textContent = ''
      },
      setItems(next) {
        if (!isWatching) return
        items = (Array.isArray(next) ? next : []).slice(-MAX_ITEMS).map(normalize)
        render()
        list.scrollTop = list.scrollHeight
      },
      upsert(item) {
        if (!isWatching || !item || typeof item.id !== 'string') return
        const index = items.findIndex((i) => i.id === item.id)
        if (index >= 0) {
          // An update without outputParts keeps what was collected from the output messages
          const previous = items[index]
          const merged = Array.isArray(item.outputParts) ? normalize(item) : { ...item, outputParts: previous.outputParts, phoneTrimmed: previous.phoneTrimmed }
          if (!STOPPABLE.has(merged.state)) stopping.delete(item.id)
          items = items.map((i) => (i.id === item.id ? merged : i))
          replace(merged)
        } else {
          items = [...items, normalize(item)].slice(-MAX_ITEMS)
          render()
        }
      },
      output(id, parts) {
        if (!isWatching || !Array.isArray(parts)) return
        const item = items.find((i) => i.id === id)
        if (!item) return
        const { parts: kept, trimmed } = trimParts([...item.outputParts, ...parts])
        const next = { ...item, outputParts: kept, phoneTrimmed: item.phoneTrimmed || trimmed }
        items = items.map((i) => (i.id === id ? next : i))
        replace(next)
      },
      stopResult({ id, ok, message }) {
        stopping.delete(id)
        if (ok) notes.delete(id)
        else notes.set(id, message || '중지하지 못했습니다.')
        const item = items.find((i) => i.id === id)
        if (item) replace(item)
      },
      /** The connection ended */
      reset() {
        isWatching = false
        items = []
        stopping.clear()
        notes.clear()
        list.textContent = ''
      },
      get isWatching() {
        return isWatching
      }
    }
  }
})()
