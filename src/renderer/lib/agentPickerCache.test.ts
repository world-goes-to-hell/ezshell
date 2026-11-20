import { describe, expect, it } from 'vitest'
import { cachedChoices, choiceKey, isCurrentChoice, rememberChoices } from './agentPickerCache'

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() { return items.size },
    clear: () => items.clear(),
    getItem: key => items.get(key) ?? null,
    key: index => [...items.keys()][index] ?? null,
    removeItem: key => { items.delete(key) },
    setItem: (key, value) => { items.set(key, String(value)) }
  }
}

const models = [{ label: 'GPT-6.2-Sol', description: 'Fast' }, { label: 'GPT-6.2-Astra', description: 'Capable' }]

describe('agentPickerCache', () => {
  it('matches the labels the CLIs print in different places', () => {
    expect(isCurrentChoice('GPT-6.2-Astra', 'gpt-6.2-astra')).toBe(true)
    expect(isCurrentChoice('Extra high', 'xhigh')).toBe(true)
    expect(isCurrentChoice('Opus 5.5', 'Opus 5.5')).toBe(true)
    expect(isCurrentChoice('High', 'xhigh')).toBe(false)
    expect(isCurrentChoice('High', null)).toBe(false)
    expect(choiceKey('Default (recommended)')).toBe('default(recommended)')
  })

  it('remembers a list per agent and what, and Codex levels per model', () => {
    const storage = memoryStorage()
    expect(cachedChoices('codex', 'model', null, storage)).toBeNull()
    rememberChoices('codex', 'model', null, models, storage)
    rememberChoices('codex', 'effort', 'gpt-6.2-sol', [{ label: 'Low', description: '' }], storage)
    expect(cachedChoices('codex', 'model', 'anything', storage)).toEqual(models)
    expect(cachedChoices('codex', 'effort', 'GPT-6.2-Sol', storage)).toEqual([{ label: 'Low', description: '' }])
    expect(cachedChoices('codex', 'effort', 'gpt-6.2-astra', storage)).toBeNull()
    expect(cachedChoices('claude', 'model', null, storage)).toBeNull()
  })

  it('replaces a list with the fresh one and ignores broken stored values', () => {
    const storage = memoryStorage()
    rememberChoices('claude', 'effort', null, [{ label: 'low', description: '' }], storage)
    rememberChoices('claude', 'effort', null, [{ label: 'low', description: '' }, { label: 'max', description: '' }], storage)
    expect(cachedChoices('claude', 'effort', null, storage)?.map(choice => choice.label)).toEqual(['low', 'max'])
    storage.setItem('agentPickerChoices', '{"claude:model":[{"label":5}],"codex:model":"x"}')
    expect(cachedChoices('claude', 'model', null, storage)).toBeNull()
    storage.setItem('agentPickerChoices', 'not json')
    expect(cachedChoices('claude', 'effort', null, storage)).toBeNull()
  })
})
