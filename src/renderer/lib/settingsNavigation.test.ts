import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPEN_SETTINGS_EVENT, openSettingsTab, takePendingJdkFeature } from './settingsNavigation'

describe('openSettingsTab', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks for the tab and leaves the JDK version for the JDK settings to take once', () => {
    const target = new EventTarget()
    const seen: unknown[] = []
    target.addEventListener(OPEN_SETTINGS_EVENT, event => seen.push((event as CustomEvent).detail))
    vi.stubGlobal('window', target)
    openSettingsTab('development', { jdkFeature: 21 })
    expect(seen).toEqual([{ tab: 'development', jdkFeature: 21 }])
    expect(takePendingJdkFeature()).toBe(21)
    expect(takePendingJdkFeature()).toBeNull()
    openSettingsTab('theme')
    expect(takePendingJdkFeature()).toBeNull()
  })
})
