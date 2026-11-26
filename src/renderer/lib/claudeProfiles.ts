import { create } from 'zustand'
import type { ClaudeProfile } from '../types'

export const DEFAULT_CLAUDE_PROFILE = { id: 'default', name: '기본 계정' }
export const OPEN_CLAUDE_PROFILE_EVENT = 'ezshell:open-claude-profile'

export interface OpenClaudeProfile {
  profileId: string
  shellId?: string
}

export function openClaudeProfile(request: OpenClaudeProfile) {
  window.dispatchEvent(new CustomEvent<OpenClaudeProfile>(OPEN_CLAUDE_PROFILE_EVENT, { detail: request }))
}

interface ClaudeProfileState {
  profiles: ClaudeProfile[]
  load: () => Promise<void>
  save: (request: { id?: string; name: string }) => Promise<string | undefined>
}

let loading: Promise<void> | undefined
export const useClaudeProfiles = create<ClaudeProfileState>((set) => ({
  profiles: [DEFAULT_CLAUDE_PROFILE],
  load() {
    loading ??= (async () => {
      const result = await window.electronAPI.claudeProfilesList()
      if (!result.success) throw new Error(result.error)
      set({ profiles: result.profiles })
    })().finally(() => { loading = undefined })
    return loading
  },
  async save(request) {
    const result = await window.electronAPI.claudeProfileSave(request)
    if (!result.success) return result.error
    set({ profiles: result.profiles })
    return undefined
  }
}))
