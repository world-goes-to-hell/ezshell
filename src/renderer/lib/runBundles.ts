// Run bundles on the card (docs/plan/2026-11-26-multi-repo-and-start-order.md part 3, mockup scene 6): where
// 모두 실행 was, the user picks a bundle ("주문 개발") or all, and starts or stops it. A bundle only picks
// presets; main runs them in the project's start order, those outside it after its stages. Kept free of React for tests.
import type { RunBundle, RunPreset, RunStartOrder, RunState } from '../types'

export type { RunBundle } from '../types'

export const MAX_BUNDLE_NAME = 20

const isActive = (state: RunState | undefined) => !!state && (state.status === 'preparing' || state.status === 'starting' || state.status === 'running')

/** The presets the start order starts (part 2); before main sends one, those in 모두 실행 */
export function orderedIds(presets: readonly RunPreset[], order?: RunStartOrder): Set<string> {
  return new Set(order ? order.stages.flatMap(stage => stage.ids) : presets.filter(preset => preset.inAll).map(preset => preset.id))
}

/** A bundle appends its other presets to the configured stages in the card's order. */
export function bundleMembers(presets: readonly RunPreset[], bundle: RunBundle | null, order?: RunStartOrder): RunPreset[] {
  const ordered = orderedIds(presets, order)
  const picked = bundle ? new Set(bundle.presetIds) : ordered
  const byId = new Map(presets.filter(preset => picked.has(preset.id)).map(preset => [preset.id, preset]))
  const staged = [...ordered].flatMap(id => byId.get(id) ?? [])
  return [...staged, ...presets.filter(preset => picked.has(preset.id) && !ordered.has(preset.id))]
}

/**
 * The head's button for the chosen bundle (or all): stop when any of its presets runs, otherwise start when one
 * of them is not running yet
 */
export function bundleHead(presets: readonly RunPreset[], states: Readonly<Record<string, RunState>>, bundle: RunBundle | null, order?: RunStartOrder) {
  const members = bundleMembers(presets, bundle, order)
  // 모두 중지 stops whatever runs, as before bundles; a bundle stops its own presets
  const running = (bundle ? members : presets).filter(preset => isActive(states[preset.id])).length
  const name = bundle ? bundle.name : '모두'
  return {
    action: running ? 'stop' as const : 'start' as const,
    label: running ? `${name} 중지` : `${name} 실행`,
    count: members.length,
    canStart: members.some(preset => !isActive(states[preset.id])),
    title: running
      ? bundle ? `‘${bundle.name}’ 묶음을 기동 순서의 거꾸로 멈춥니다` : '실행 중인 구성을 모두 멈춥니다'
      : members.length ? `${members.map(preset => preset.name).join(', ')}을(를) 기동 순서대로 띄웁니다` : '띄울 구성이 없습니다'
  }
}

/** The bundle chosen last on this project's card (this PC only), when it still exists */
const choiceKey = (projectKey: string) => `ezshell.runBundle.${projectKey}`

export function readBundleChoice(projectKey: string, bundles: readonly RunBundle[]): RunBundle | null {
  try {
    const id = localStorage.getItem(choiceKey(projectKey))
    return bundles.find(bundle => bundle.id === id) ?? null
  } catch {
    return null
  }
}

export function writeBundleChoice(projectKey: string, bundle: RunBundle | null) {
  try {
    if (bundle) localStorage.setItem(choiceKey(projectKey), bundle.id)
    else localStorage.removeItem(choiceKey(projectKey))
  } catch { /* the choice is only for this card */ }
}

/** The bundle draft to save, or what is missing (main checks again: names, ids, counts) */
export function bundleFromDraft(draft: { id?: string; name: string; presetIds: readonly string[] }, presets: readonly RunPreset[], others: readonly RunBundle[]):
  { bundle: { id?: string; name: string; presetIds: string[] } } | { error: string } {
  const name = draft.name.trim()
  if (!name) return { error: '묶음 이름을 입력해 주세요.' }
  if ([...name].length > MAX_BUNDLE_NAME) return { error: `묶음 이름은 ${MAX_BUNDLE_NAME}자까지입니다.` }
  if (others.some(bundle => bundle.name === name && bundle.id !== draft.id)) return { error: '같은 이름의 묶음이 있습니다.' }
  const known = new Set(presets.map(preset => preset.id))
  const presetIds = [...new Set(draft.presetIds)].filter(id => known.has(id))
  if (!presetIds.length) return { error: '묶음에 넣을 실행 구성을 하나 이상 골라 주세요.' }
  return { bundle: { ...(draft.id ? { id: draft.id } : {}), name, presetIds } }
}
