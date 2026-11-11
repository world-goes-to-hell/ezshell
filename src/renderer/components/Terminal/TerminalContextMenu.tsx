import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiArrowRightSLine } from 'react-icons/ri'
import type { IconType } from 'react-icons'
import './TerminalContextMenu.css'

export interface TerminalMenuItem {
  label: string
  icon: IconType
  onSelect: () => void
  disabled?: boolean
}

export interface TerminalMenuGroup {
  label: string
  icon: IconType
  items: TerminalMenuItem[]
}

interface TerminalContextMenuProps {
  position: { x: number; y: number }
  /** Shown directly in the menu, above the groups */
  top: TerminalMenuItem[]
  /** Each opens a submenu to the side */
  groups: TerminalMenuGroup[]
  onClose: () => void
}

function Item({ item }: { item: TerminalMenuItem }) {
  return (
    <DropdownMenu.Item className="terminal-menu-item" disabled={item.disabled} onSelect={item.onSelect}>
      <item.icon size={15} className="terminal-menu-icon" aria-hidden="true" />
      <span>{item.label}</span>
    </DropdownMenu.Item>
  )
}

/**
 * Right-click menu of a terminal. A dropdown menu opened at the pointer (its trigger is an empty
 * point there), so submenus, keyboard use and staying inside the window come from Radix.
 * Not modal: a right-click elsewhere in the terminal moves the menu instead of only closing it.
 */
export function TerminalContextMenu({ position, top, groups, onClose }: TerminalContextMenuProps) {
  return (
    <DropdownMenu.Root open modal={false} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DropdownMenu.Trigger asChild>
        <span className="terminal-menu-anchor" style={{ left: position.x, top: position.y }} aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="terminal-menu"
          side="bottom"
          align="start"
          sideOffset={0}
          collisionPadding={8}
          // The caller puts the keyboard back in the terminal; the anchor is not focusable
          onCloseAutoFocus={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {top.map(item => <Item key={item.label} item={item} />)}
          {top.length > 0 && <DropdownMenu.Separator className="terminal-menu-separator" />}
          {groups.map(group => (
            <DropdownMenu.Sub key={group.label}>
              <DropdownMenu.SubTrigger className="terminal-menu-item">
                <group.icon size={15} className="terminal-menu-icon" aria-hidden="true" />
                <span>{group.label}</span>
                <RiArrowRightSLine size={15} className="terminal-menu-more" aria-hidden="true" />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="terminal-menu" sideOffset={4} collisionPadding={8}>
                  {group.items.map(item => <Item key={item.label} item={item} />)}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
