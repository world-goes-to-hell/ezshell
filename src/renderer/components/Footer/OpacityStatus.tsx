import { useState } from 'react'
import { RiContrastDrop2Line } from 'react-icons/ri'
import { useThemeStore } from '../../stores/themeStore'
import { MIN_WINDOW_OPACITY } from '../../lib/appearance'
import { StatusRange } from './StatusRange'

export function OpacityStatus() {
  const windowOpacity = useThemeStore(state => state.windowOpacity)
  const setWindowOpacity = useThemeStore(state => state.setWindowOpacity)
  const [open, setOpen] = useState(false)

  if (typeof window.electronAPI?.setWindowOpacity !== 'function') return null

  return (
    <StatusRange label="창 투명도" icon={<RiContrastDrop2Line size={14} aria-hidden="true" />}
      open={open} onOpenChange={setOpen} value={Math.round(windowOpacity * 100)}
      min={MIN_WINDOW_OPACITY * 100} max={100} step={5}
      onValueChange={percent => setWindowOpacity(percent / 100)} onReset={() => setWindowOpacity(1)} />
  )
}
