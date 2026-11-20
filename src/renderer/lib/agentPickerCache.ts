// The models and effort levels an agent CLI offered, remembered so the usage line's menu shows them at once
// (reading them from the CLI's own picker takes seconds). Refreshed whenever main reads the whole list again:
// the menu's refresh button, or applying a choice. Codex's levels depend on the model, so they are kept per
// model. Only labels and descriptions the CLI printed: nothing about the user's work.

export type PickerKind = 'claude' | 'codex'
export type PickerWhat = 'model' | 'effort'
export interface PickerChoice {
  label: string
  description: string
}

const STORAGE_KEY = 'agentPickerChoices'
const MAX_CHOICES = 50
const MAX_ENTRIES = 40

type Store = Record<string, PickerChoice[]>

/** Labels compared as the CLIs print them in different places: "GPT-6.2-Astra" / "gpt-6.2-astra", "Extra high" / "xhigh" */
export function choiceKey(value: string): string {
  const plain = value.toLowerCase().replace(/[\s_-]/g, '')
  return plain === 'extrahigh' ? 'xhigh' : plain
}

/** Whether a choice of the menu is the value the usage line shows now */
export function isCurrentChoice(label: string, current: string | null | undefined): boolean {
  return Boolean(current) && choiceKey(label) === choiceKey(current as string)
}

function entryKey(kind: PickerKind, what: PickerWhat, model?: string | null): string {
  // Codex's levels belong to a model; Claude's are the same for every model
  return kind === 'codex' && what === 'effort' ? `${kind}:effort:${choiceKey(model ?? '')}` : `${kind}:${what}`
}

function validChoices(value: unknown): PickerChoice[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_CHOICES) return null
  const choices = value.filter((item): item is PickerChoice =>
    typeof item?.label === 'string' && item.label.length > 0 && item.label.length <= 100
    && typeof item.description === 'string' && item.description.length <= 300)
  return choices.length === value.length ? choices.map(({ label, description }) => ({ label, description })) : null
}

function readStore(storage: Storage | undefined): Store {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const store: Store = {}
    for (const [key, value] of Object.entries(parsed).slice(0, MAX_ENTRIES)) {
      const choices = validChoices(value)
      if (choices) store[key] = choices
    }
    return store
  } catch {
    return {}
  }
}

const defaultStorage = (): Storage | undefined => {
  try { return globalThis.localStorage } catch { return undefined }
}

/** The remembered list, or null (never read yet) */
export function cachedChoices(kind: PickerKind, what: PickerWhat, model?: string | null, storage = defaultStorage()): PickerChoice[] | null {
  return readStore(storage)[entryKey(kind, what, model)] ?? null
}

/** Keeps the whole list main just read */
export function rememberChoices(kind: PickerKind, what: PickerWhat, model: string | null | undefined, choices: PickerChoice[], storage = defaultStorage()): void {
  const clean = validChoices(choices)
  if (!clean) return
  try {
    const store = readStore(storage)
    const key = entryKey(kind, what, model)
    delete store[key]
    // The newest last; the oldest dropped first when there are too many models' levels
    const entries = [...Object.entries(store), [key, clean] as const].slice(-MAX_ENTRIES)
    storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // Storage full or blocked: the menu reads the list from the CLI next time
  }
}
