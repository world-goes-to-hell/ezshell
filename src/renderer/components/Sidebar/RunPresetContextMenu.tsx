import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiArrowRightSLine, RiListUnordered } from 'react-icons/ri'
import { useRef, type ReactNode } from 'react'
import type { RunActionItem } from '../../lib/runPresetActions'
import type { RunPreset } from '../../types'
import '../Terminal/TerminalContextMenu.css'

export function RunMenuActions({ actions }: { actions: readonly RunActionItem[] }) {
  return actions.map(({ id, label, Icon, enabled, danger, run }) => (
    <DropdownMenu.Item key={id} className={`terminal-menu-item${danger ? ' run-presets-danger' : ''}`}
      disabled={!enabled} onSelect={() => void run()}>
      <Icon size={15} className="terminal-menu-icon" aria-hidden="true" />
      <span>{label}</span>
    </DropdownMenu.Item>
  ))
}

function RunMenuSub({ label, children, icon, onEscape }: { label: string; children: ReactNode; icon?: ReactNode; onEscape: () => void }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="terminal-menu-item run-context-trigger" title={label}>
        {icon}<span className="run-context-label">{label}</span>
        <RiArrowRightSLine size={15} className="terminal-menu-more" aria-hidden="true" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent className="terminal-menu sidebar-popover run-context-menu" sideOffset={4} collisionPadding={8}
          onEscapeKeyDown={onEscape}>
          {children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}

export interface RunContextGroup { label: string; presets: RunPreset[]; actions: RunActionItem[] }

export function RunPresetContextMenu({ position, actions, groups = [], bundles = [], actionsFor, onClose }: {
  position: { x: number; y: number; focusOnEscape?: HTMLElement }
  actions: RunActionItem[]
  groups?: RunContextGroup[]
  bundles?: { id: string; label: string; actions: RunActionItem[] }[]
  actionsFor: (preset: RunPreset) => RunActionItem[]
  onClose: () => void
}) {
  const escaped = useRef(false)
  const onEscape = () => { escaped.current = true }

  return (
    <DropdownMenu.Root open modal={false} onOpenChange={open => { if (!open) onClose() }}>
      <DropdownMenu.Trigger asChild>
        <span className="terminal-menu-anchor" aria-hidden="true" style={{ left: position.x, top: position.y }} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="terminal-menu sidebar-popover run-context-menu" align="start" collisionPadding={8}
          onEscapeKeyDown={onEscape} onCloseAutoFocus={event => {
            event.preventDefault()
            if (escaped.current && position.focusOnEscape?.isConnected && document.activeElement === document.body) {
              position.focusOnEscape.focus({ preventScroll: true })
            }
          }} onContextMenu={event => event.preventDefault()}>
          <RunMenuActions actions={actions} />
          {bundles.map(bundle => (
            <RunMenuSub key={bundle.id} label={bundle.label} onEscape={onEscape}><RunMenuActions actions={bundle.actions} /></RunMenuSub>
          ))}
          {groups.length > 0 && <>
            <DropdownMenu.Separator className="terminal-menu-separator" />
            <RunMenuSub label="구성 고르기" onEscape={onEscape} icon={<RiListUnordered size={15} className="terminal-menu-icon" aria-hidden="true" />}>
              {groups.map(group => (
                <DropdownMenu.Group key={group.label} className="run-context-stage" aria-label={group.label}>
                  {group.actions.length > 0
                    ? <RunMenuSub label={group.label} onEscape={onEscape}><RunMenuActions actions={group.actions} /></RunMenuSub>
                    : <DropdownMenu.Label className="run-context-stage-label">{group.label}</DropdownMenu.Label>}
                  {group.presets.map(preset => (
                    <RunMenuSub key={preset.id} label={preset.name} onEscape={onEscape}><RunMenuActions actions={actionsFor(preset)} /></RunMenuSub>
                  ))}
                </DropdownMenu.Group>
              ))}
            </RunMenuSub>
          </>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
