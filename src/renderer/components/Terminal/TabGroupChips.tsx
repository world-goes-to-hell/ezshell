// The work in front, at the start of the tab strip (docs/plan/2026-11-19-tab-groups-by-project.md).
// One button with the current work's name; pressing it lists the works that have tabs, like a select
// (the user did not want every work laid out in a row). Hidden when the only tabs are general ones.
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiArrowDownSLine, RiCheckLine, RiFolder3Line, RiStackLine } from 'react-icons/ri'
import { GENERAL_GROUP } from '../../lib/tabGroups'
import type { TabGroupView } from '../../hooks/useTabGroups'
import './TabGroupChips.css'

const iconOf = (key: string) => (key === GENERAL_GROUP ? RiStackLine : RiFolder3Line)

export function TabGroupChips({ view }: { view: TabGroupView }) {
  const current = view.groups.find(group => group.key === view.activeGroup)
  if (!current || (view.groups.length < 2 && current.key === GENERAL_GROUP)) return null
  const CurrentIcon = iconOf(current.key)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="tab-group-select" aria-label={`작업 묶음: ${current.label} (눌러서 바꾸기)`} title={`${current.label} · 탭 ${current.tabIds.length}개`}>
          <CurrentIcon size={13} aria-hidden="true" />
          <span className="tab-group-select-name">{current.label}</span>
          {view.groups.length > 1 && <span className="tab-group-select-more">{view.groups.length}</span>}
          <RiArrowDownSLine size={14} className="tab-group-select-chevron" aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="tab-group-menu" align="start" sideOffset={4} collisionPadding={8}>
          <DropdownMenu.Label className="tab-group-menu-label">작업 묶음</DropdownMenu.Label>
          {view.groups.map(group => {
            const Icon = iconOf(group.key)
            const isActive = group.key === view.activeGroup
            return (
              <DropdownMenu.Item key={group.key} className={`tab-group-option${isActive ? ' is-active' : ''}`} data-group={group.key} onSelect={() => view.openGroup(group.key)}>
                <Icon size={14} aria-hidden="true" />
                <span className="tab-group-option-name">{group.label}</span>
                <span className="tab-group-option-count">탭 {group.tabIds.length}</span>
                <RiCheckLine size={14} className="tab-group-option-check" aria-hidden={!isActive} style={{ visibility: isActive ? 'visible' : 'hidden' }} />
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
