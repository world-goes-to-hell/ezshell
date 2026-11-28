import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const DEFAULT_RUN_SUMMARY_THRESHOLD = 8
export const MAX_RUN_SUMMARY_THRESHOLD = 50

interface RunSummaryPrefs {
  threshold: number
  pins: Record<string, string[]>
}

function validThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_RUN_SUMMARY_THRESHOLD
}

function readPins(value: unknown): RunSummaryPrefs['pins'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, ids]) => {
    if (!Array.isArray(ids)) return []
    const presetIds = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    return presetIds.length ? [[key, presetIds]] : []
  }))
}

export const useRunSummary = create<RunSummaryPrefs>()(persist(
  () => ({ threshold: DEFAULT_RUN_SUMMARY_THRESHOLD, pins: {} }),
  {
    name: 'ezshell.runSummary',
    merge: (saved, current) => {
      const prefs = saved as Partial<RunSummaryPrefs> | undefined
      return {
        threshold: validThreshold(prefs?.threshold) ? prefs.threshold : current.threshold,
        pins: readPins(prefs?.pins),
      }
    },
  },
))

export function setRunSummaryThreshold(threshold: number) {
  if (validThreshold(threshold) && threshold !== useRunSummary.getState().threshold) useRunSummary.setState({ threshold })
}

export function toggleRunPresetPin(projectKey: string, presetId: string) {
  useRunSummary.setState(state => {
    const previous = Object.prototype.hasOwnProperty.call(state.pins, projectKey) ? state.pins[projectKey] : []
    const next = previous.includes(presetId) ? previous.filter(id => id !== presetId) : [...previous, presetId]
    const pins = { ...state.pins, [projectKey]: next }
    if (!next.length) delete pins[projectKey]
    return { pins }
  })
}
