import { RiSubtractFill, RiCheckboxBlankFill, RiCloseFill, RiSettings3Fill } from 'react-icons/ri'

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
        <span className="title-bar-title">My SSH Client</span>
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
