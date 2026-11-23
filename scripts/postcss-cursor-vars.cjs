// PostCSS plugin: `cursor: pointer` → `cursor: var(--ez-cursor-pointer, pointer)` in every CSS file
// the renderer build reads (the app's, Tailwind's and packages' such as xterm.css).
//
// 설정 > 테마 > 마우스 포인터 puts the chosen pointer images in these :root properties
// (src/renderer/lib/pointerAppearance.ts). While the system pointer is chosen they are not set,
// and each declaration falls back to its own keyword: nothing changes.
// Only a value that is one of the replaced keywords is rewritten (`url(…), pointer` stays as it is).

/** CSS keyword → the state whose image replaces it */
const STATE_OF = {
  default: 'default',
  pointer: 'pointer',
  text: 'text',
  wait: 'wait',
  progress: 'progress',
  'not-allowed': 'not-allowed',
  grab: 'grab',
  grabbing: 'grabbing',
  'col-resize': 'col-resize',
  'ew-resize': 'col-resize',
  'row-resize': 'row-resize',
  'ns-resize': 'row-resize',
  crosshair: 'crosshair'
}

function rewriteCursor(value) {
  const keyword = value.trim().toLowerCase()
  const state = Object.prototype.hasOwnProperty.call(STATE_OF, keyword) ? STATE_OF[keyword] : null
  return state ? `var(--ez-cursor-${state}, ${keyword})` : null
}

const plugin = () => ({
  postcssPlugin: 'ezshell-cursor-vars',
  Declaration: {
    cursor(decl) {
      const next = rewriteCursor(decl.value)
      if (next) decl.value = next
    }
  }
})
plugin.postcss = true

module.exports = plugin
module.exports.rewriteCursor = rewriteCursor
