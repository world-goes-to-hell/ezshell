import type { ReactNode } from 'react'
import { RiSubtractFill, RiCheckboxBlankFill, RiCloseFill } from 'react-icons/ri'
import './PopoutTitleBar.css'

interface PopoutTitleBarProps {
  icon: ReactNode
  title: string
  /** Secondary text after the title, e.g. "user@host" */
  subtitle?: string
  /** Extra buttons shown before the window controls (use className "popout-title-action") */
  actions?: ReactNode
}

/** Title bar of a popped-out terminal / SFTP window, matching the main window's title bar. */
export function PopoutTitleBar({ icon, title, subtitle, actions }: PopoutTitleBarProps) {
  return (
    <div className="title-bar popout-title-bar">
      <div className="title-bar-drag popout-title-drag">
        <span className="popout-title-icon" aria-hidden="true">{icon}</span>
        <span className="popout-title-text" title={subtitle ? `${title} (${subtitle})` : title}>
          <span className="popout-title-main">{title}</span>
          {subtitle && <span className="popout-title-sub">{subtitle}</span>}
        </span>
      </div>
      <div className="title-bar-controls">
        {actions}
        {actions && <span className="popout-title-separator" aria-hidden="true" />}
        <button className="title-bar-btn" onClick={() => window.electronAPI.minimizeWindow()} title="최소화" aria-label="최소화">
          <RiSubtractFill size={18} />
        </button>
        <button className="title-bar-btn" onClick={() => window.electronAPI.maximizeWindow()} title="최대화" aria-label="최대화">
          <RiCheckboxBlankFill size={16} />
        </button>
        <button className="title-bar-btn title-bar-close" onClick={() => window.electronAPI.closeWindow()} title="닫기" aria-label="닫기">
          <RiCloseFill size={18} />
        </button>
      </div>
    </div>
  )
}
