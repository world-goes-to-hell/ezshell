import { useEffect, useRef } from 'react'
import { useSftpStore, type Transfer } from '../stores/sftpStore'
import { finishedInto, startedInto } from '../lib/transferMarks'

// Several transfers usually start / finish close together; refresh once for the burst
const RELOAD_DELAY_MS = 400

interface Options {
  sessionId: string
  localPath: string
  remotePath: string
  reloadLocal: () => unknown
  reloadRemote: () => unknown
  /** True while a list is loading; the list loaders ignore calls then, so the reload waits */
  isBusy?: boolean
}

/**
 * Re-read a list when a transfer into the folder it shows starts or finishes:
 * - start: the target file now exists, so its row (with the progress donut) appears right away
 * - finish: the row gets its final size / time
 */
export function useReloadOnTransferActivity({ sessionId, localPath, remotePath, reloadLocal, reloadRemote, isBusy = false }: Options) {
  // Not a selector: for a session with no state yet the store returns a fresh array on every call
  const transfers = useSftpStore().transfers(sessionId)
  const prevRef = useRef<Transfer[]>(transfers)
  const latest = useRef({ localPath, remotePath, reloadLocal, reloadRemote, isBusy })
  latest.current = { localPath, remotePath, reloadLocal, reloadRemote, isBusy }
  const pending = useRef({ local: false, remote: false })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = transfers
    if (prev === transfers) return

    const { localPath: local, remotePath: remote } = latest.current
    const changedInto = (side: 'local' | 'remote', dir: string) =>
      startedInto(prev, transfers, side, dir) || finishedInto(prev, transfers, side, dir)
    pending.current = {
      local: pending.current.local || changedInto('local', local),
      remote: pending.current.remote || changedInto('remote', remote)
    }
    if (!pending.current.local && !pending.current.remote) return

    if (timerRef.current) clearTimeout(timerRef.current)
    const fire = () => {
      // A list is loading (navigation, another refresh): try again instead of losing the reload
      if (latest.current.isBusy) {
        timerRef.current = setTimeout(fire, RELOAD_DELAY_MS)
        return
      }
      timerRef.current = null
      const due = pending.current
      pending.current = { local: false, remote: false }
      if (due.remote) latest.current.reloadRemote()
      if (due.local) latest.current.reloadLocal()
    }
    timerRef.current = setTimeout(fire, RELOAD_DELAY_MS)
  }, [transfers])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])
}
