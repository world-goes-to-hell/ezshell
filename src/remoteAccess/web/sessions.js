// Session list of the phone page as the PC sidebar shows it: folders (fold and unfold), the folder's
// colour as a line along its contents, the session's own colour, the sidebar order, and a dot for
// the tabs open on the PC. Plain script (no build step); server text goes in as textContent only.
(() => {
  'use strict'
  const ns = (window.ezRemote = window.ezRemote || {})

  // Only plain hex colours are drawn: anything else from the server is ignored
  const COLOR = /^#[0-9a-f]{3,8}$/i
  const colorOf = (value) => (typeof value === 'string' && COLOR.test(value) ? value : null)

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  /**
   * Folders and sessions in sidebar order. An older server sends only the folder name on each
   * session: those names become top-level folders in the order they first appear.
   */
  function normalize(folders, sessions) {
    const list = Array.isArray(sessions) ? sessions : []
    if (Array.isArray(folders)) return { folders, sessions: list }
    const byName = new Map()
    const made = []
    const withIds = list.map((session) => {
      const name = typeof session.folder === 'string' ? session.folder : ''
      if (!name) return { ...session, folderId: null }
      if (!byName.has(name)) {
        const id = `name:${name}`
        byName.set(name, id)
        made.push({ id, name, parentId: null, color: null })
      }
      return { ...session, folderId: byName.get(name) }
    })
    return { folders: made, sessions: withIds }
  }

  /**
   * @param {{ list: HTMLElement, filter: HTMLInputElement, onOpen: (session: object) => void }} options
   */
  ns.createSessionTree = function createSessionTree({ list, filter, onOpen }) {
    let folders = []
    let sessions = []
    // Folded or not, per folder id, for as long as the page is open (not stored)
    const expanded = new Map()

    function update(nextFolders, nextSessions) {
      const normalized = normalize(nextFolders, nextSessions)
      folders = normalized.folders
      sessions = normalized.sessions
      for (const folder of folders) {
        if (!expanded.has(folder.id)) expanded.set(folder.id, folder.expanded !== false)
      }
      render()
    }

    // A folder whose parent is not in the list is shown at the top level instead of disappearing
    const isTop = (f) => (f.parentId ?? null) === null || !folders.some((o) => o.id === f.parentId)
    const childrenOf = (parentId) => folders.filter((f) => (parentId === null ? isTop(f) : f.parentId === parentId))
    const sessionsIn = (folderId) => sessions.filter((s) => (s.folderId ?? null) === folderId)
    const known = (folderId) => folderId !== null && folders.some((f) => f.id === folderId)

    /** Sessions under a folder and all its sub-folders (guarded against a parent loop) */
    function countIn(folderId, seen = new Set()) {
      if (seen.has(folderId)) return 0
      seen.add(folderId)
      return sessionsIn(folderId).length + childrenOf(folderId).reduce((sum, f) => sum + countIn(f.id, seen), 0)
    }

    function statusDot(session) {
      const tabs = session.openTabs || {}
      const connected = Number(tabs.connected) || 0
      const disconnected = Number(tabs.disconnected) || 0
      const dot = el('span', 'tree-dot')
      if (connected > 0) dot.classList.add('is-connected')
      else if (disconnected > 0) dot.classList.add('is-lost')
      const total = connected + disconnected
      dot.setAttribute('aria-label', total === 0 ? '열린 탭 없음' : `PC 에 열린 탭 ${total}개 (연결 ${connected}, 끊김 ${disconnected})`)
      return { dot, total }
    }

    function sessionRow(session, depth) {
      const button = el('button', 'tree-session')
      button.type = 'button'
      button.style.setProperty('--depth', String(depth))
      const color = colorOf(session.color)
      if (color) {
        button.classList.add('has-color')
        button.style.setProperty('--session-color', color)
      }
      const { dot, total } = statusDot(session)
      button.append(dot, el('span', 'tree-name', session.name))
      if (total > 0) button.append(el('span', 'tree-tabs', String(total)))
      button.addEventListener('click', () => onOpen(session))
      return button
    }

    function folderBlock(folder, depth, query, seen) {
      if (seen.has(folder.id)) return null
      seen.add(folder.id)
      const content = el('div', 'tree-children')
      for (const child of childrenOf(folder.id)) {
        const block = folderBlock(child, depth + 1, query, seen)
        if (block) content.append(block)
      }
      for (const session of sessionsIn(folder.id)) {
        if (!query || matches(session, query)) content.append(sessionRow(session, depth + 1))
      }
      // While searching, folders without a match are left out and the rest are open
      if (query && content.childElementCount === 0 && !folder.name.toLowerCase().includes(query)) return null
      const isOpen = query ? true : expanded.get(folder.id) !== false
      const block = el('div', 'tree-folder')
      const color = colorOf(folder.color)
      if (color) {
        block.classList.add('has-color')
        block.style.setProperty('--folder-color', color)
      }
      const head = el('button', 'tree-folder-head')
      head.type = 'button'
      head.style.setProperty('--depth', String(depth))
      head.setAttribute('aria-expanded', String(isOpen))
      head.append(el('span', 'tree-chevron', isOpen ? '▾' : '▸'), el('span', 'tree-name', folder.name), el('span', 'tree-count', String(countIn(folder.id))))
      head.addEventListener('click', () => {
        if (query) return
        expanded.set(folder.id, !isOpen)
        render()
      })
      content.hidden = !isOpen
      block.append(head, content)
      return block
    }

    const matches = (session, query) => session.name.toLowerCase().includes(query)

    function render() {
      const query = filter.value.trim().toLowerCase()
      list.textContent = ''
      const seen = new Set()
      for (const folder of childrenOf(null)) {
        const block = folderBlock(folder, 0, query, seen)
        if (block) list.append(block)
      }
      // Sessions in no folder, or in a folder the list does not have, come after the folders
      for (const session of sessions) {
        if (known(session.folderId ?? null)) continue
        if (!query || matches(session, query)) list.append(sessionRow(session, 0))
      }
      if (list.childElementCount === 0) {
        list.append(el('p', 'empty', sessions.length === 0 ? '저장된 세션이 없습니다.' : '찾는 세션이 없습니다.'))
      }
    }

    filter.addEventListener('input', render)
    return { update, render }
  }
})()
