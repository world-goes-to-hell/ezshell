// Closing a tab with the wheel button (middle click), as in browsers and editors. Used by the tab strip (App.tsx) and
// each screen's strip (SplitPaneTabBar.tsx); the close itself is the same as the tab's × (asks first when needed).
import type { MouseEvent } from 'react'

const MIDDLE = 1

export function middleClickClose(close: () => void) {
  return {
    // Keep the press from starting the wheel's auto scroll or pasting the selection (Linux)
    onMouseDown: (event: MouseEvent) => { if (event.button === MIDDLE) event.preventDefault() },
    // auxclick fires once the wheel is released over the same tab: a press dragged off the tab closes nothing
    onAuxClick: (event: MouseEvent) => {
      if (event.button !== MIDDLE) return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }
}
