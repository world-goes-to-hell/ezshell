// What the workspace panel's Git tabs last read (history, changes, a commit's files), kept in memory so
// opening a tab again shows it at once while a new read runs (stale-while-revalidate). The answers hold
// paths: memory only, and cleared when the app locks.

export interface ReadCache {
  /** The last answer kept for `key` */
  peek<T>(key: string): T | undefined
  /**
   * Reads `key`: shares a read already running for it unless the cache was invalidated since that read
   * began, and keeps the answer when `keep` accepts it (failures are not kept)
   */
  read<T>(key: string, load: () => Promise<T>, keep?: (value: T) => boolean): Promise<T>
  /**
   * New reads from now on: a read already running is no longer shared and its answer is not kept. Keys
   * `drop` matches are forgotten (what a commit made out of date must not show again)
   */
  invalidate(drop?: (key: string) => boolean): void
  /** Forgets everything (the app locked) */
  clear(): void
}

/**
 * `limitOf` names a key's group and how many of that group to keep (a big repository's status holds
 * thousands of files: few of those, many small lists)
 */
export function createReadCache({ limitOf = () => ({ group: '', max: 200 }) }: { limitOf?: (key: string) => { group: string; max: number } } = {}): ReadCache {
  // Map order is use order: the oldest of the group goes first when it is full
  const entries = new Map<string, unknown>()
  const running = new Map<string, { epoch: number; promise: Promise<unknown> }>()
  let epoch = 0

  const store = (key: string, value: unknown) => {
    entries.delete(key)
    entries.set(key, value)
    const { group, max } = limitOf(key)
    const members = [...entries.keys()].filter(other => limitOf(other).group === group)
    for (const old of members.slice(0, Math.max(0, members.length - max))) entries.delete(old)
  }

  return {
    peek<T>(key: string) {
      return entries.get(key) as T | undefined
    },
    read<T>(key: string, load: () => Promise<T>, keep: (value: T) => boolean = () => true) {
      const shared = running.get(key)
      if (shared && shared.epoch === epoch) return shared.promise as Promise<T>
      const started = epoch
      const promise = Promise.resolve().then(load).then(value => {
        if (started === epoch && keep(value)) store(key, value)
        return value
      }).finally(() => {
        if (running.get(key)?.promise === promise) running.delete(key)
      })
      running.set(key, { epoch: started, promise })
      return promise
    },
    invalidate(drop) {
      epoch += 1
      if (!drop) return
      for (const key of [...entries.keys()]) if (drop(key)) entries.delete(key)
    },
    clear() {
      epoch += 1
      entries.clear()
      running.clear()
    }
  }
}

/** How many of each kind to keep: histories and changes can be large, a commit's files are small */
export const GIT_READ_LIMITS: Record<string, number> = { log: 20, status: 20, files: 200 }

/** The group of a key below (its kind) and that kind's limit */
export function gitReadLimit(key: string) {
  const group = key.slice(0, key.indexOf('\n'))
  return { group, max: GIT_READ_LIMITS[group] ?? 20 }
}

/** The workspace panel's Git answers */
export const gitReads = createReadCache({ limitOf: gitReadLimit })

export const gitLogKey = (folder: string, allBranches: boolean) => `log\n${allBranches ? 'all' : 'checkout'}\n${folder}`
export const gitStatusKey = (root: string) => `status\n${root}`
export const gitCommitFilesKey = (root: string, hash: string) => `files\n${root}\n${hash}`

/** After a commit: the history and the changes of every repository are out of date (a commit's files never are) */
export function forgetAfterCommit(cache: ReadCache = gitReads) {
  cache.invalidate(key => !key.startsWith('files\n'))
}

/** Whether an IPC answer is one to keep: `{ success: true, … }` */
export const succeeded = (value: unknown) => typeof value === 'object' && value !== null && (value as { success?: unknown }).success === true
