// Serialized into the page's isolated world by both review surfaces.
function describeBrowserElement(element) {
  function selectorFor(element, root) {
    const parts = []
    for (let node = element; node; node = node.parentElement) {
      const unique = selector => root.querySelectorAll(selector).length === 1
      const id = node.id && '#' + CSS.escape(node.id)
      const tag = CSS.escape(node.localName)
      const testId = node.getAttribute('data-testid')
      if (id && unique(id)) return [id, ...parts].join(' > ')
      if (testId) {
        const locator = '[data-testid="' + CSS.escape(testId) + '"]'
        if (unique(locator)) return [locator, ...parts].join(' > ')
      }
      if (unique(tag)) return [tag, ...parts].join(' > ')
      let index = 1
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === node.localName) index++
      }
      parts.unshift(tag + ':nth-of-type(' + index + ')')
    }
    return parts.join(' > ')
  }

  const selectors = []
  for (let node = element; node;) {
    const root = node.getRootNode()
    selectors.unshift(selectorFor(node, root))
    node = root.host
  }
  const label = element.getAttribute('aria-label') || element.innerText || element.textContent || ''
  const text = (element.innerText ?? element.textContent ?? '').replace(/\s+/g, ' ').trim()
  const classes = []
  let classLength = 0
  for (const value of element.classList) {
    classLength += value.length + 8
    if (classLength > 600) break
    classes.push(value)
  }
  return {
    selectors,
    selector: selectors.join(' >>> '),
    tag: element.localName,
    label: label.replace(/\s+/g, ' ').trim().slice(0, 200),
    text: Array.from(text.slice(0, 60)).slice(0, 30).join(''),
    classes
  }
}

function pickBrowserElement(describe) {
  globalThis.cancelEzShellPick?.()
  return new Promise(resolve => {
    const outline = document.createElement('div')
    Object.assign(outline.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', display: 'none',
      boxSizing: 'border-box', border: '2px solid #25baf0', background: '#25baf026'
    })
    document.documentElement.append(outline)
    const pointedElement = event => event.composedPath().find(node => node instanceof Element)
    function move(event) {
      const element = pointedElement(event)
      if (!element) return
      const { x, y, width, height } = element.getBoundingClientRect()
      Object.assign(outline.style, {
        display: 'block', left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px'
      })
    }
    function intercept(event) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    function click(event) {
      intercept(event)
      const element = pointedElement(event)
      finish(element ? describe(element) : null)
    }
    function key(event) {
      if (event.key !== 'Escape') return
      intercept(event)
      finish(null)
    }
    const cancel = () => finish(null)
    const listeners = { pointermove: move, pointerdown: intercept, pointerup: intercept, click, keydown: key }
    function finish(result) {
      for (const [name, listener] of Object.entries(listeners)) window.removeEventListener(name, listener, true)
      outline.remove()
      delete globalThis.cancelEzShellPick
      resolve(result)
    }
    for (const [name, listener] of Object.entries(listeners)) window.addEventListener(name, listener, true)
    globalThis.cancelEzShellPick = cancel
  })
}

function readReviewViewport(describe, action, expected, x, y, amount) {
  let tracker = globalThis.ezShellReviewViewport
  if (!tracker) {
    const changed = () => tracker.revision++
    tracker = { id: Math.random(), revision: 0, observer: new MutationObserver(changed), changed }
    tracker.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    window.addEventListener('scroll', changed, true)
    globalThis.ezShellReviewViewport = tracker
  }
  if (tracker.observer.takeRecords().length) tracker.revision++
  clearTimeout(tracker.timer)
  tracker.timer = setTimeout(() => {
    tracker.observer.disconnect()
    window.removeEventListener('scroll', tracker.changed, true)
    delete globalThis.ezShellReviewViewport
  }, 12_000)

  const width = window.innerWidth
  const height = window.innerHeight
  const viewport = [tracker.id, tracker.revision, width, height, window.scrollX, window.scrollY, window.devicePixelRatio]
  if (action === 'read') return width > 0 && height > 0 ? viewport : null
  // Scrolling can use the current hit target after a DOM-only change. Selecting needs the captured revision.
  if (!expected.every((value, index) => value === viewport[index] || (action === 'scroll' && index === 1))) return null
  const px = x * width
  const py = y * height
  let element = document.elementFromPoint(px, py)
  while (element?.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(px, py)
    if (!inner || inner === element) break
    element = inner
  }
  if (action === 'scroll') {
    const options = { top: amount * height, behavior: 'instant' }
    for (let node = element; node; node = node.parentElement || node.getRootNode().host) {
      if (!/^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)) continue
      const canMove = options.top < 0 ? node.scrollTop > 0 : node.scrollHeight - node.clientHeight - node.scrollTop > 1
      if (!canMove) continue
      node.scrollBy(options)
      return true
    }
    window.scrollBy(options)
    return true
  }
  if (!element || element.localName === 'iframe') return { element: null }
  const rect = element.getBoundingClientRect()
  const left = Math.max(0, rect.left)
  const top = Math.max(0, rect.top)
  return {
    element: describe(element),
    rect: { x: left / width, y: top / height, width: (Math.min(width, rect.right) - left) / width,
      height: (Math.min(height, rect.bottom) - top) / height }
  }
}

// Vue attaches its component instance to the page world's DOM wrappers. Resolve the CSS path
// produced by the isolated picker and read only the component's identifying strings.
function readVueComponent(selectors) {
  let root = document
  let element
  for (const selector of selectors) {
    element = root?.querySelector(selector)
    if (!element) return null
    root = element.shadowRoot
  }
  for (let node = element; node; node = node.parentElement || node.getRootNode().host) {
    const type = node.__vueParentComponent?.type
    if (!type) continue
    const file = typeof type.__file === 'string' ? type.__file : ''
    const name = type.__name || type.name
    if (!name && !file) continue
    return {
      component: typeof name === 'string' && name ? name : file.split(/[\\/]/).pop()?.replace(/\.vue$/, ''),
      componentFile: file
    }
  }
  return null
}

module.exports = { describeBrowserElement, pickBrowserElement, readReviewViewport, readVueComponent }
