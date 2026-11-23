// The right-click menu of a browser tab's page, as a web browser has it (2026-11-23 user report: links,
// copying a link's address and inspecting were missing). The page is a view drawn over the app window, so
// an HTML menu of the app would be hidden under it: this is a native menu.
// browserContextMenu(params, page) → menu template; params: Electron's 'context-menu' details,
// page: { canGoBack, canGoForward, isWebUrl(url), openTab(url), openExternal(url), copy(text), back, forward,
//         reload, copyImage(x, y), edit(role), inspect(x, y) }

const MAX_COPY = 4096

function browserContextMenu(params, page) {
  const items = []
  const group = (...entries) => {
    if (items.length && entries.length) items.push({ type: 'separator' })
    items.push(...entries)
  }
  const link = typeof params.linkURL === 'string' && params.linkURL.length <= MAX_COPY ? params.linkURL : ''
  if (link) {
    const web = page.isWebUrl(link)
    group(
      { label: '새 탭에서 링크 열기', enabled: web, click: () => page.openTab(link) },
      { label: '기본 브라우저에서 링크 열기', enabled: web, click: () => page.openExternal(link) },
      { label: '링크 주소 복사', click: () => page.copy(link) },
      ...(params.linkText?.trim() && !params.selectionText ? [{ label: '링크 텍스트 복사', click: () => page.copy(params.linkText.trim().slice(0, MAX_COPY)) }] : [])
    )
  }
  const image = params.mediaType === 'image' && typeof params.srcURL === 'string' && params.srcURL.length <= MAX_COPY ? params.srcURL : ''
  if (image) {
    group(
      { label: '새 탭에서 이미지 열기', enabled: page.isWebUrl(image), click: () => page.openTab(image) },
      { label: '이미지 복사', click: () => page.copyImage(params.x, params.y) },
      { label: '이미지 주소 복사', click: () => page.copy(image) }
    )
  }
  const flags = params.editFlags ?? {}
  if (params.isEditable) {
    group(
      { label: '실행 취소', accelerator: 'CmdOrCtrl+Z', enabled: !!flags.canUndo, click: () => page.edit('undo') },
      { label: '다시 실행', accelerator: 'CmdOrCtrl+Y', enabled: !!flags.canRedo, click: () => page.edit('redo') },
      { type: 'separator' },
      { label: '잘라내기', accelerator: 'CmdOrCtrl+X', enabled: !!flags.canCut, click: () => page.edit('cut') },
      { label: '복사', accelerator: 'CmdOrCtrl+C', enabled: !!flags.canCopy, click: () => page.edit('copy') },
      { label: '붙여넣기', accelerator: 'CmdOrCtrl+V', enabled: !!flags.canPaste, click: () => page.edit('paste') },
      { label: '모두 선택', accelerator: 'CmdOrCtrl+A', enabled: !!flags.canSelectAll, click: () => page.edit('selectAll') }
    )
  } else if (params.selectionText?.trim()) {
    group({ label: '복사', accelerator: 'CmdOrCtrl+C', click: () => page.edit('copy') })
  }
  if (!link && !image && !params.isEditable && !params.selectionText?.trim()) {
    group(
      { label: '뒤로', accelerator: 'Alt+Left', enabled: page.canGoBack, click: page.back },
      { label: '앞으로', accelerator: 'Alt+Right', enabled: page.canGoForward, click: page.forward },
      { label: '새로고침', accelerator: 'CmdOrCtrl+R', click: page.reload },
      { type: 'separator' },
      { label: '페이지 주소 복사', enabled: !!params.pageURL, click: () => page.copy(String(params.pageURL).slice(0, MAX_COPY)) }
    )
  }
  group({ label: '검사', accelerator: 'CmdOrCtrl+Shift+I', click: () => page.inspect(params.x, params.y) })
  return items
}

module.exports = { browserContextMenu }
