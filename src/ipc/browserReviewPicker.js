// Serialized into the page's isolated world. The page has no access to the app's preload or IPC.
function pickBrowserElement() {
  globalThis.cancelEzShellPick?.()
  return new Promise(resolve => {
    const outline = document.createElement('div')
    Object.assign(outline.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', display: 'none',
      boxSizing: 'border-box', border: '2px solid #25baf0', background: '#25baf026'
    })
    document.documentElement.append(outline)

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

    function describe(element) {
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

module.exports = { pickBrowserElement, readVueComponent }
