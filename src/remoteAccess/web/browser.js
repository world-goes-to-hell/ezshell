// Review an already open PC page. A tap in selection mode identifies an element without clicking it.
(() => {
  'use strict'
  const ns = (window.ezRemote = window.ezRemote || {})
  let viewId = 0

  ns.createBrowserReview = function createBrowserReview({ send, find = id => document.getElementById(id) }) {
    const $ = name => find('pc-browser-' + name)
    const root = $('view')
    const image = $('image')
    const picture = $('picture')
    const outline = $('outline')
    const pick = $('pick')
    const form = $('form')
    const recipient = $('agent')
    const draft = $('draft')
    let view = null
    let timer = null
    let agentsEnabled = false
    let swipe = null

    function note(text) {
      $('note').textContent = text
      $('note').hidden = !text
    }

    function updateOutline() {
      const rect = view?.selection?.rect
      outline.hidden = !rect || image.hidden
      if (outline.hidden) return
      const bounds = image.getBoundingClientRect()
      const area = picture.getBoundingClientRect()
      outline.style.left = `${bounds.left - area.left + rect.x * bounds.width}px`
      outline.style.top = `${bounds.top - area.top + rect.y * bounds.height}px`
      outline.style.width = `${rect.width * bounds.width}px`
      outline.style.height = `${rect.height * bounds.height}px`
    }

    function render() {
      root.hidden = !view
      image.hidden = !view?.hasImage
      const ready = Boolean(view?.frameId && !view.pending && !view.ended)
      pick.disabled = !ready
      pick.setAttribute('aria-pressed', String(Boolean(view?.picking)))
      pick.textContent = view?.picking ? '선택 취소' : view?.selection ? '다시 선택' : '요소 선택'
      picture.classList.toggle('is-picking', Boolean(view?.picking))
      $('up').disabled = $('down').disabled = !ready || view.picking
      $('refresh').disabled = !view || Boolean(view.pending || view.ended)
      form.hidden = !view?.selection
      $('element').textContent = view?.selection?.label || view?.selection?.tag || ''
      $('selector').textContent = view?.selection?.selector || ''
      $('selector').title = $('selector').textContent
      recipient.disabled = !agentsEnabled || !view?.recipients?.length || Boolean(view.pending)
      draft.disabled = !agentsEnabled || view?.pending === 'browser-request'
      $('send').disabled = !ready || recipient.disabled || !recipient.value || !draft.value.trim()
      updateOutline()
    }

    function recipients(list) {
      const previous = recipient.value
      view.recipients = list
      recipient.replaceChildren(new Option(list.length ? '에이전트를 선택하세요' : '연결된 에이전트 없음', ''),
        ...list.map(agent => new Option(agent.id, agent.id)))
      if (list.some(agent => agent.id === previous)) recipient.value = previous
    }

    function post(type, payload = {}) {
      if (!view || view.pending || view.ended) return
      view.pending = type
      send({ type, tabId: view.tabId, viewId: view.id, ...payload })
      render()
    }

    function scheduleFrame(delay = 1800) {
      clearTimeout(timer)
      if (!view || view.ended || view.picking || view.selection || document.hidden) return
      timer = setTimeout(() => post('browser-frame'), delay)
    }

    function open(tabId) {
      view = { tabId, id: ++viewId }
      note('PC 브라우저 화면을 불러오는 중…')
      post('browser-open')
    }

    function close(notify) {
      if (view && notify) send({ type: 'browser-close', tabId: view.tabId, viewId: view.id })
      view = null
      swipe = null
      clearTimeout(timer)
      image.removeAttribute('src')
      draft.value = ''
      recipient.replaceChildren()
      note('')
      render()
    }

    function freshFrame() {
      view.selection = null
      view.picking = false
      view.frameId = null
      scheduleFrame(0)
      render()
    }

    function setAgentsEnabled(value) {
      if (agentsEnabled === value) return
      agentsEnabled = value
      if (view?.selection && !value) {
        recipients([])
        note('PC 설정에서 휴대폰 에이전트 쓰기를 켜 주세요.')
      } else if (view?.selection) post('browser-recipients')
      render()
    }

    pick.addEventListener('click', () => {
      view.selection = null
      view.picking = !view.picking
      note(view.picking ? '화면에서 수정할 요소를 탭하세요.' : '')
      scheduleFrame(0)
      render()
    })

    function imagePoint(event) {
      const rect = image.getBoundingClientRect()
      return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
    }

    image.addEventListener('click', event => {
      if (!view?.picking || !view.frameId || view.pending) return
      post('browser-pick', { frameId: view.frameId, ...imagePoint(event) })
    })
    image.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch' || !event.isPrimary || !view?.frameId || view.picking) return
      swipe = { id: event.pointerId, point: imagePoint(event), y: event.clientY }
      image.setPointerCapture(event.pointerId)
    })
    image.addEventListener('pointerup', event => {
      if (swipe?.id !== event.pointerId) return
      const { point, y } = swipe
      swipe = null
      const distance = event.clientY - y
      if (Math.abs(distance) >= 30) scroll(distance < 0 ? 1 : -1, point)
    })
    image.addEventListener('pointercancel', () => { swipe = null })

    function scroll(direction, point = { x: .5, y: .5 }) {
      if (!view?.frameId || view.pending || view.picking) return
      view.selection = null
      post('browser-scroll', { frameId: view.frameId, direction, ...point })
    }
    $('up').addEventListener('click', () => scroll(-1))
    $('down').addEventListener('click', () => scroll(1))
    $('refresh').addEventListener('click', () => { note(''); freshFrame() })
    recipient.addEventListener('change', render)
    draft.addEventListener('input', render)
    form.addEventListener('submit', event => {
      event.preventDefault()
      if ($('send').disabled) return
      note('수정 요청을 보내는 중…')
      post('browser-request', { selectionId: view.selection.id, agentId: recipient.value, text: draft.value })
    })
    document.addEventListener('visibilitychange', () => scheduleFrame(0))
    new ResizeObserver(updateOutline).observe(picture)

    async function showFrame(active, msg) {
      const next = new Image()
      next.src = 'data:image/jpeg;base64,' + msg.jpeg
      let loaded = false
      try {
        await next.decode()
        loaded = true
      } catch {
        // Retry below.
      }
      if (view !== active || active.ended) return
      active.pending = null
      if (loaded) {
        image.src = next.src
        if (!active.hasImage) note('')
        active.hasImage = true
        active.frameId = msg.frameId
      }
      render()
      scheduleFrame()
    }

    function onMessage(msg) {
      if (!view || msg.tabId !== view.tabId || msg.viewId !== view.id) return
      switch (msg.type) {
        case 'browser-opened':
          view.pending = null
          scheduleFrame(0)
          break
        case 'browser-image':
          return void showFrame(view, msg)
        case 'browser-ended':
          clearTimeout(timer)
          Object.assign(view, { ended: true, pending: null, frameId: null, hasImage: false, picking: false, selection: null })
          image.removeAttribute('src')
          note(msg.message)
          break
        case 'browser-result':
          view.pending = null
          if (msg.error) note(msg.error)
          if (msg.refresh) return freshFrame()
          if (Array.isArray(msg.recipients)) recipients(agentsEnabled ? msg.recipients : [])
          if (msg.selection) {
            view.selection = msg.selection
            view.picking = false
            note(!agentsEnabled ? 'PC 설정에서 휴대폰 에이전트 쓰기를 켜 주세요.' : '')
          }
          if (msg.operation === 'browser-request' && msg.ok) {
            draft.value = ''
            note('선택한 요소의 수정 요청을 보냈습니다.')
            return freshFrame()
          }
          scheduleFrame(msg.retry ? 700 : undefined)
          break
      }
      render()
    }

    return {
      get isOpen() { return Boolean(view) },
      get ended() { return Boolean(view?.ended) },
      open, close, setAgentsEnabled, onMessage
    }
  }
})()
