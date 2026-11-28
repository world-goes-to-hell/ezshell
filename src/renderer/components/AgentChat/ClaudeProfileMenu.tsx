import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { RiArrowDownSLine } from 'react-icons/ri'
import { DEFAULT_CLAUDE_PROFILE, openClaudeProfile, useClaudeProfiles, type OpenClaudeProfile } from '../../lib/claudeProfiles'
import { openSettingsTab } from '../../lib/settingsNavigation'
import '../Terminal/NewTabMenu.css'

const ACTIONS: { mode: NonNullable<OpenClaudeProfile['mode']>; label: string }[] = [
  { mode: 'continue', label: '이 대화를 이어서' },
  { mode: 'new', label: '새 세션' }
]

export function ClaudeProfileMenu({ shellId, profileId = DEFAULT_CLAUDE_PROFILE.id }: { shellId: string; profileId?: string }) {
  const profiles = useClaudeProfiles(state => state.profiles)
  const current = profiles.find(profile => profile.id === profileId)?.name ?? 'Claude 계정'
  const others = profiles.filter(profile => profile.id !== profileId)
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
          <DropdownMenu.Item className="new-tab-menu-item" disabled>
            <span className="new-tab-menu-text">{current}<span className="new-tab-menu-sub">사용 중</span></span>
          </DropdownMenu.Item>
          {others.length > 0 && ACTIONS.map(({ mode, label }) => [
            <DropdownMenu.Separator key={mode + '-separator'} className="new-tab-menu-separator" />,
            ...others.map(profile => <DropdownMenu.Item key={mode + profile.id} className="new-tab-menu-item"
              data-profile-action={mode} data-profile-name={profile.name}
              onSelect={() => openClaudeProfile({ shellId, profileId: profile.id, mode })}>
              <span className="new-tab-menu-text">{profile.name}<span className="new-tab-menu-sub">{label}</span></span>
            </DropdownMenu.Item>)
          ])}
          <DropdownMenu.Separator className="new-tab-menu-separator" />
          <DropdownMenu.Item className="new-tab-menu-item" onSelect={() => openSettingsTab('claude-accounts')}>계정 관리…</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
