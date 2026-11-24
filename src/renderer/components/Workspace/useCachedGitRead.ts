// A Git read of the workspace panel that shows what was read last time at once and reads again behind it
// (lib/gitReadCache.ts). Reads again when the key or `revision` (refresh, a commit) changes.
import { useEffect, useRef, useState } from 'react'
import { gitReads, succeeded } from '../../lib/gitReadCache'

export interface CachedGitRead<T> {
  /** This read's answer, or while it runs the last one kept; undefined while nothing is known yet */
  value: T | undefined
  /** False while showing an earlier answer and a newer read runs */
  fresh: boolean
}

/**
 * `load` must not throw (turn a failure into an answer). With `immutable` (a commit's files) a kept
 * answer is final and not read again.
 */
export function useCachedGitRead<T>(key: string | null, load: () => Promise<T>, revision = 0, { immutable = false } = {}): CachedGitRead<T> {
  const loadRef = useRef(load)
  loadRef.current = load
  const [sample, setSample] = useState<{ key: string; revision: number; value: T } | null>(null)
  useEffect(() => {
    if (key === null) return
    let active = true
    const kept = immutable ? gitReads.peek<T>(key) : undefined
    const answer = kept !== undefined ? Promise.resolve(kept) : gitReads.read(key, () => loadRef.current(), succeeded)
    void answer.then(value => { if (active) setSample({ key, revision, value }) })
    return () => { active = false }
  }, [key, revision, immutable])
  if (key === null) return { value: undefined, fresh: false }
  if (sample?.key === key) return { value: sample.value, fresh: sample.revision === revision }
  return { value: gitReads.peek<T>(key), fresh: false }
}
