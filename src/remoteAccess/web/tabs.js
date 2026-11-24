// Follow the primary terminal of an SSH tab open on the PC. The PC owns the shell and its size.
(() => {
  'use strict'
  const ns = (window.ezRemote = window.ezRemote || {})
  const COLOR = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i
  const TEXT_INPUT = /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]+$/

  function el(tag, className, text) {
    const node = document.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function bindTerminalInput(terminal, onData) {
    let expected = null
    function expect(data) {
      expected = data
      queueMicrotask(() => { expected = null })
    }
    // xterm emits onKey just before onData for a key. Only that matching event may forward a
    // key sequence. With no key, IME input can emit plain text or a single delete character.
    terminal.onKey(({ key, domEvent }) => {
      if (domEvent.isTrusted) expect(key)
    })
    terminal.element.addEventListener('paste', (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!event.isTrusted) return
      const text = event.clipboardData?.getData('text/plain').replace(/\r?\n/g, '\r')
      if (!TEXT_INPUT.test(text || '')) return
      // Bracketed paste may only wrap the text from this clipboard event.
      if (terminal.modes.bracketedPasteMode) expect(`\x1b[200~${text}\x1b[201~`)
      terminal.paste(text)
    }, true)
    terminal.onData((data) => {
      const fromKeyOrPaste = expected === data
      expected = null
      if (fromKeyOrPaste || data === '\x7f' || TEXT_INPUT.test(data)) onData(data)
    })
  }

  ns.createTabs = function createTabs({ list, name, notice, mode, viewport, host, send, show, createTerminal, onData, setKeysVisible, onClose }) {
    let tabId = null
    let terminal = null
    let ended = false
    let inputAllowed = false
    let touch = null

    // xterm handles vertical touch scrollback and cancels touchmove even for a horizontal drag.
    // Let the outer native scroller receive horizontal swipes without that cancellation.
    viewport.addEventListener('touchstart', (event) => {
      const point = event.touches.length === 1 ? event.touches[0] : null
      touch = point ? { x: point.clientX, y: point.clientY, axis: null } : null
    }, { passive: true, capture: true })
    viewport.addEventListener('touchmove', (event) => {
      if (!touch || event.touches.length !== 1) return
      const point = event.touches[0]
      if (!touch.axis) {
        const dx = Math.abs(point.clientX - touch.x)
        const dy = Math.abs(point.clientY - touch.y)
        if (Math.max(dx, dy) >= 4) touch.axis = dx > dy ? 'x' : 'y'
      }
      if (touch.axis === 'x') event.stopPropagation()
    }, { passive: true, capture: true })

    function setNotice(text) {
      notice.textContent = text
      notice.hidden = !text
    }

    function attach(tab) {
      if (tab.id === tabId && !ended) return
      detach()
      tabId = tab.id
      updateSelection()
      inputAllowed = tab.inputAllowed === true
      name.textContent = tab.name
      mode.hidden = inputAllowed
      setNotice('PC 탭에 연결하는 중…')
      show('tab-terminal')
      setKeysVisible(false)
      send({ type: 'tab-attach', tabId })
    }

    function detach(notify = true) {
      if (notify && tabId !== null) send({ type: 'tab-detach', tabId })
      tabId = null
      ended = false
      inputAllowed = false
      terminal?.dispose()
      terminal = null
      host.replaceChildren()
      viewport.scrollLeft = 0
      viewport.scrollTop = 0
      updateSelection()
    }

    function updateSelection() {
      for (const row of list.querySelectorAll('[data-pc-tab-id]')) {
        const active = row.dataset.pcTabId === tabId
        row.parentElement.classList.toggle('active', active)
        row.nextElementSibling.hidden = !active
        if (active) row.setAttribute('aria-current', 'true')
        else row.removeAttribute('aria-current')
      }
    }

    function end(text) {
      ended = true
      disableInput()
      setNotice(text)
    }

    function disableInput() {
      setKeysVisible(false)
      if (terminal) {
        terminal.options.disableStdin = true
        terminal.textarea.readOnly = true
        terminal.textarea.inputMode = 'none'
        terminal.blur()
      }
    }

    function render(tabs) {
      const rows = []
      for (const tab of Array.isArray(tabs) ? tabs : []) {
        if (!tab || typeof tab.id !== 'string') continue
        const item = el('div', 'terminal-tab pc-tab-item')
        const row = el('button', 'tree-session pc-tab-row')
        row.type = 'button'
        row.dataset.pcTabId = tab.id
        if (typeof tab.color === 'string' && COLOR.test(tab.color)) {
          row.classList.add('has-color')
          row.style.setProperty('--session-color', tab.color)
        }
        const dot = el('span', `tree-dot ${tab.connected ? 'is-connected' : 'is-lost'}`)
        dot.setAttribute('aria-hidden', 'true')
        const glyph = el('span', 'terminal-glyph', '>_')
        glyph.setAttribute('aria-hidden', 'true')
        const state = tab.connected ? '연결됨' : '연결 끊김'
        const access = tab.inputAllowed === true ? state : `${state} · 보기만`
        row.setAttribute('aria-label', `${tab.name} · ${access}`)
        row.title = `${tab.name} · ${access}`
        const details = el('span', 'pc-tab-details')
        details.append(el('span', 'tree-name', tab.name))
        if (tab.folder) details.append(el('span', 'pc-tab-folder muted', tab.folder))
        row.append(glyph, dot, details, el('span', 'muted', access))
        row.addEventListener('click', () => attach(tab))
        const close = el('button', 'tab-close pc-tab-close', '×')
        close.type = 'button'
        close.setAttribute('aria-label', `${tab.name} 이어 보기 닫기`)
        close.addEventListener('click', onClose)
        item.append(row, close)
        rows.push(item)
      }
      list.replaceChildren(...(rows.length ? rows : [el('p', 'empty', 'PC에 열린 SSH 탭이 없습니다.')]))
      updateSelection()
    }

    return {
      get selectedId() { return ended ? null : tabId },
      reopen: attach,
      enter() {
        if (!list.childElementCount) list.append(el('p', 'empty', 'PC 탭 목록을 불러오는 중…'))
        send({ type: 'tabs-list' })
      },
      detach,
      reset() {
        detach(false)
        list.replaceChildren()
      },
      input(data) {
        if (inputAllowed && terminal && !ended && tabId !== null) send({ type: 'tab-input', tabId, data })
      },
      focus() {
        if (inputAllowed && !ended) terminal?.focus()
      },
      setTheme(theme) {
        if (terminal) terminal.options.theme = theme
      },
      onMessage(msg) {
        if (msg.type === 'tabs') {
          render(msg.tabs)
          return
        }
        if (tabId === null || msg.tabId !== tabId || ended) return
        switch (msg.type) {
          case 'tab-attached':
            if (terminal) break
            if (!Number.isInteger(msg.cols) || !Number.isInteger(msg.rows) || msg.cols < 2 || msg.rows < 1) {
              end('PC 탭의 터미널 크기를 받지 못했습니다.')
              break
            }
            inputAllowed = inputAllowed && msg.inputAllowed !== false
            mode.hidden = inputAllowed
            terminal = createTerminal({ cols: msg.cols, rows: msg.rows, disableStdin: !inputAllowed })
            terminal.open(host)
            if (inputAllowed) {
              bindTerminalInput(terminal, onData)
              setKeysVisible(true)
            } else disableInput()
            setNotice('')
            if (typeof msg.snapshot === 'string') terminal.write(msg.snapshot)
            break
          case 'tab-data':
            if (typeof msg.data === 'string') terminal?.write(msg.data)
            break
          case 'tab-ended':
            end(msg.reason === 'closed' ? 'PC에서 이 탭을 닫았습니다.' : 'PC 탭의 연결이 끊겼습니다.')
            break
          case 'tab-error':
            end(msg.message || 'PC 탭에 연결하지 못했습니다.')
            break
        }
      }
    }
  }
})()
