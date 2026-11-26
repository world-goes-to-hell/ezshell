import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiArrowDownSLine } from 'react-icons/ri'
import { DEFAULT_CLAUDE_PROFILE, openClaudeProfile, useClaudeProfiles } from '../../lib/claudeProfiles'
import { openSettingsTab } from '../../lib/settingsNavigation'
import '../Terminal/NewTabMenu.css'

export function ClaudeProfileMenu({ shellId, profileId = DEFAULT_CLAUDE_PROFILE.id }: { shellId: string; profileId?: string }) {
  const profiles = useClaudeProfiles(state => state.profiles)
  const current = profiles.find(profile => profile.id === profileId)?.name ?? 'Claude 계정'
  return (
    <DropdownMenu.Root onOpenChange={open => { if (open) void useClaudeProfiles.getState().load().catch(() => {}) }}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="agent-chat-profile"
          aria-label={`Claude 계정 · ${current}`} title={current}>
          <span>{current}</span><RiArrowDownSLine aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="new-tab-menu" align="end" sideOffset={5} collisionPadding={8}>
          {profiles.map(profile => <DropdownMenu.Item key={profile.id} className="new-tab-menu-item"
            disabled={profile.id === profileId} onSelect={() => openClaudeProfile({ shellId, profileId: profile.id })}>
            {profile.name}
          </DropdownMenu.Item>)}
          <DropdownMenu.Separator className="new-tab-menu-separator" />
          <DropdownMenu.Item className="new-tab-menu-item" onSelect={() => openSettingsTab('claude-accounts')}>계정 관리…</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
