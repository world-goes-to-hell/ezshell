/**
 * Double-clicking the title bar of a glass window. Such a window cannot be maximized natively (it would
 * lose its acrylic), and presses on a drag region never reach the page, so main reports a double press
 * with its point and the page decides: if the point is on a drag region, it asks for the same "fill
 * the screen" as the maximize button.
 */

/** 'drag' / 'no-drag' of the nearest element that says so; the property does not inherit */
export function appRegionAt(element: Element | null): 'drag' | 'no-drag' | null {
  for (let node = element; node; node = node.parentElement) {
    const region = getComputedStyle(node).getPropertyValue('-webkit-app-region').trim()
    if (region === 'drag' || region === 'no-drag') return region
  }
  return null
}

export function installCaptionDoubleClick() {
  const api = window.electronAPI
  if (typeof api?.onCaptionDoubleClick !== 'function') return
  api.onCaptionDoubleClick(point => {
    const ratio = window.devicePixelRatio || 1
    const element = document.elementFromPoint(point.x / ratio, point.y / ratio)
    if (appRegionAt(element) === 'drag') api.maximizeWindow()
  })
}
