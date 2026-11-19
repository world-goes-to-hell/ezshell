import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiAddLine, RiFileCopyLine, RiServerLine, RiAddCircleLine, RiComputerLine, RiFolderOpenLine, RiGlobalLine } from 'react-icons/ri'
import './NewTabMenu.css'

interface NewTabMenuProps {
  /** Name of the tab that "현재 세션 복제" would copy; null disables the item */
  duplicateLabel: string | null
  onDuplicate: () => void
  onPickSession: () => void
  onNewSession: () => void
  /** A terminal of this PC */
  onLocalTerminal: () => void
  onLocalProject: () => void
  onOpenBrowser: () => void
  /** Extra class for the + button (the split pane header styles it like its other buttons) */
  triggerClassName?: string
}

export function NewTabMenu({ duplicateLabel, onDuplicate, onPickSession, onNewSession, onLocalTerminal, onLocalProject, onOpenBrowser, triggerClassName }: NewTabMenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={`new-tab-btn ${triggerClassName ?? ''}`} title="새 탭" aria-label="새 탭">
          <RiAddLine size={18} />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="new-tab-menu" align="start" sideOffset={4} collisionPadding={8}>
          <DropdownMenu.Item className="new-tab-menu-item" disabled={!duplicateLabel} onSelect={onDuplicate}>
            <RiFileCopyLine size={16} />
            <div className="new-tab-menu-text">
              <span>현재 세션 복제</span>
              {duplicateLabel && <span className="new-tab-menu-sub">{duplicateLabel}</span>}
            </div>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="new-tab-menu-item" onSelect={onPickSession}>
            <RiServerLine size={16} />
            <span>기존 세션 선택…</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="new-tab-menu-item" onSelect={onLocalTerminal}>
            <RiComputerLine size={16} />
            <span>로컬 터미널</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="new-tab-menu-item" onSelect={onLocalProject}>
            <RiFolderOpenLine size={16} />
            <span>로컬 작업…</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="new-tab-menu-item" onSelect={onOpenBrowser}>
            <RiGlobalLine size={16} />
            <span>브라우저 열기</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="new-tab-menu-separator" />
          <DropdownMenu.Item className="new-tab-menu-item" onSelect={onNewSession}>
            <RiAddCircleLine size={16} />
            <span>새 세션…</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
