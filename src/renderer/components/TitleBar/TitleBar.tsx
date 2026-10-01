import { RiSubtractFill, RiCheckboxBlankFill, RiCloseFill, RiSettings3Fill } from 'react-icons/ri'
// ?no-inline: emitted as a file; a small SVG would otherwise become a data: URL, which the page CSP (img-src 'self') blocks
import appIcon from '../../assets/app-icon.svg?no-inline'

interface TitleBarProps {
  onSettingsClick?: () => void
}

export function TitleBar({ onSettingsClick }: TitleBarProps) {
  const handleMinimize = () => window.electronAPI?.minimizeWindow()
  const handleMaximize = () => window.electronAPI?.maximizeWindow()
  const handleClose = () => window.electronAPI?.closeWindow()

  return (
    <div className="title-bar">
      <div className="title-bar-drag">
        <img className="title-bar-icon" src={appIcon} alt="" width={16} height={16} draggable={false} />
        <span className="title-bar-title">ezShell</span>
      </div>
      <div className="title-bar-controls">
        {onSettingsClick && (
          <button className="title-bar-btn" onClick={onSettingsClick} title="설정">
            <RiSettings3Fill size={18} />
          </button>
        )}
        <button className="title-bar-btn" onClick={handleMinimize}>
          <RiSubtractFill size={18} />
        </button>
        <button className="title-bar-btn" onClick={handleMaximize}>
          <RiCheckboxBlankFill size={16} />
        </button>
        <button className="title-bar-btn title-bar-close" onClick={handleClose}>
          <RiCloseFill size={18} />
        </button>
      </div>
    </div>
  )
}
