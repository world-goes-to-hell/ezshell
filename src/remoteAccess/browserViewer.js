const { randomUUID } = require('node:crypto')
const { cleanChatText } = require('../agentChat/ipc.js')

const FRAME_INTERVAL_MS = 650
const FRAME_MAX_AGE_MS = 15_000
const MAX_REQUEST = 4000
const OFF = 'PC에서 브라우저 검토 공유를 껐습니다.'
const CHANGED = 'PC의 화면이 바뀌었습니다. 화면을 갱신한 뒤 다시 선택해 주세요.'
const CLOSED = 'PC에서 브라우저 탭이 닫혔습니다.'
const fraction = value => Number.isFinite(value) && value >= 0 && value < 1

/** Frame and element records for each pane on this connection never leave main. */
function createBrowserViewer({ browser, send, canUse, canAsk, attachError, log, now = Date.now }) {
  const openViews = new Map()
  let busy = false
  let lastCapture = -Infinity

  function reply(view, type, data = {}) {
    send({ type, viewId: view.viewId, tabId: view.tabId, ...data })
  }

  function closeView(view, notice) {
    openViews.delete(view.viewId)
    if (notice) reply(view, 'browser-ended', { message: notice })
  }

  function close(notice) {
    for (const view of openViews.values()) closeView(view, notice)
  }

  async function handle(message) {
    if (!Number.isSafeInteger(message.viewId) || typeof message.tabId !== 'string' || message.tabId.length > 100) return
    if (!canUse()) {
      if (message.type === 'browser-open') reply(message, 'browser-ended', { message: OFF })
      return
    }
    if (message.type === 'browser-open') {
      const error = attachError?.(message.viewId)
      if (error) return reply(message, 'browser-ended', { message: error })
      const tab = browser.tab(message.tabId)
      if (!tab?.available) return reply(message, 'browser-ended', { message: CLOSED })
      const view = { tab, tabId: message.tabId, viewId: message.viewId, frame: null, selected: null }
      openViews.set(view.viewId, view)
      log('browser-open', { tabId: view.tabId })
      reply(view, 'browser-opened')
      return
    }
    const view = openViews.get(message.viewId)
    if (!view || view.tabId !== message.tabId) return
    if (message.type === 'browser-close') return closeView(view)
    if (!view.tab.available) return closeView(view, CLOSED)
    if (busy) return reply(view, 'browser-result', {
      operation: message.type,
      ...(message.type === 'browser-frame' ? { retry: true } : { error: 'PC 화면을 읽는 중입니다.' })
    })
    const stillOpen = () => openViews.get(view.viewId) === view && canUse()
    const result = (data = {}) => { if (stillOpen()) reply(view, 'browser-result', { operation: message.type, ...data }) }
    const recipients = () => canAsk() ? browser.recipients() : []

    busy = true
    try {
      switch (message.type) {
        case 'browser-frame': {
          if (now() - lastCapture < FRAME_INTERVAL_MS) return result({ retry: true })
          lastCapture = now()
          const preview = await view.tab.capture()
          if (!stillOpen()) return
          if (!preview) return result({ retry: true })
          view.frame = { id: randomUUID(), source: preview.frame, at: now() }
          return reply(view, 'browser-image', { frameId: view.frame.id, jpeg: preview.jpeg })
        }
        case 'browser-pick':
        case 'browser-scroll': {
          view.selected = null
          const frame = view.frame
          if (!frame || frame.id !== message.frameId || now() - frame.at >= FRAME_MAX_AGE_MS) return result({ error: CHANGED, refresh: true })
          if (!fraction(message.x) || !fraction(message.y)) return result({ error: '브라우저 화면 안에서 선택해 주세요.' })
          if (message.type === 'browser-scroll') {
            if (message.direction !== -1 && message.direction !== 1) return result({ error: '이동할 방향을 선택해 주세요.' })
            const moved = await view.tab.scroll(frame.source, message.x, message.y, message.direction * 0.75)
            view.frame = null
            return result(moved ? { refresh: true } : { error: CHANGED, refresh: true })
          }
          const picked = await view.tab.pick(frame.source, message.x, message.y)
          if (!stillOpen()) return
          if (!picked) return result({ error: CHANGED, refresh: true })
          if (!picked.selection) return result({ error: '이 위치에서 요소를 선택할 수 없습니다.' })
          view.selected = { selection: picked.selection, source: frame.source }
          const { id, tag, label, selector } = picked.selection
          return result({ selection: { id, tag, label, selector, rect: picked.rect }, recipients: recipients() })
        }
        case 'browser-recipients':
          return result({ recipients: recipients() })
        case 'browser-request': {
          if (!canAsk()) return result({ error: 'PC 설정에서 휴대폰 에이전트 쓰기를 켜 주세요.' })
          const selected = view.selected
          if (!selected || selected.selection.id !== message.selectionId) return result({ error: '페이지에서 요소를 다시 선택해 주세요.' })
          const text = cleanChatText(message.text)?.trim()
          if (!text || text.length > MAX_REQUEST) return result({ error: '수정 요청을 4000자 이내로 입력해 주세요.' })
          if (typeof message.agentId !== 'string' || message.agentId.length > 120) return result({ error: '받는 에이전트를 선택해 주세요.' })
          const response = view.tab.send(selected.source, selected.selection, message.agentId, text)
          log('browser-request', { tabId: view.tabId, agent: message.agentId, ok: response.success === true })
          if (!response.success) return result({ error: response.error, refresh: response.refresh })
          view.selected = null
          return result({ ok: true })
        }
      }
    } catch {
      result({ error: 'PC 브라우저에서 요청을 처리하지 못했습니다.', refresh: message.type === 'browser-pick' })
    } finally {
      busy = false
    }
  }

  return { close, handle, get count() { return openViews.size }, has: viewId => openViews.has(viewId) }
}

module.exports = { createBrowserViewer }
