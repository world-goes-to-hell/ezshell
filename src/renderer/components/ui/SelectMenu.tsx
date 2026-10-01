import type { CSSProperties, ReactNode } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiArrowDownSLine, RiCheckLine } from 'react-icons/ri'
import './SelectMenu.css'

export interface SelectMenuOption {
  value: string
  label: string
  /** Applied to the option row (e.g. a font preview); the trigger shows it too when the option is chosen */
  style?: CSSProperties
}

interface SelectMenuProps {
  value: string
  options: SelectMenuOption[]
  onChange: (value: string) => void
  /** Accessible name of the control */
  ariaLabel: string
  /** Shown before the chosen label in the trigger */
  icon?: ReactNode
  /** Trigger element id, so a <label htmlFor> can point at it */
  id?: string
  className?: string
  /** 'compact' fits toolbars (SFTP path bar); 'field' matches form inputs */
  size?: 'compact' | 'field'
}

/**
 * A themed replacement for <select>: the closed control and the open list both use the app's colors
 * (a native select's list is drawn by the OS). Radix DropdownMenu radio items give keyboard navigation
 * (↑↓, Home/End, type-ahead, Enter, Esc) and screen reader roles.
 */
export function SelectMenu({ value, options, onChange, ariaLabel, icon, id, className = '', size = 'field' }: SelectMenuProps) {
  const chosen = options.find(option => option.value === value)

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          id={id}
          type="button"
          className={`select-menu-trigger is-${size} ${className}`}
          aria-label={`${ariaLabel}: ${chosen?.label ?? '선택 안 됨'}`}
        >
          {icon}
          <span className="select-menu-value" style={chosen?.style}>{chosen?.label ?? '선택'}</span>
          <RiArrowDownSLine size={16} className="select-menu-chevron" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={`select-menu-content is-${size}`} align="start" sideOffset={4} collisionPadding={8}>
          <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
            {options.map(option => (
              <DropdownMenu.RadioItem key={option.value} value={option.value} className="select-menu-item" style={option.style}>
                <span className="select-menu-item-label">{option.label}</span>
                <DropdownMenu.ItemIndicator className="select-menu-check">
                  <RiCheckLine size={16} />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
