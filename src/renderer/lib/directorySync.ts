/**
 * SFTP directory sync: with sync on, moving in one list (local or remote) moves the other list the same
 * way. Going up N levels takes the other side up N levels; entering a folder enters the folder of the
 * same name on the other side, and if there is none the sync cannot go on.
 *
 * These are the rules the SFTP panel has always applied (SftpPanel.tsx), as pure functions so the
 * popped-out SFTP window follows the same ones.
 */

interface Entry {
  name: string
  type: string
}

export type SyncMove =
  /** Take the other list to this path */
  | { kind: 'go'; path: string }
  /** The other side has no folder of this name: sync has to be turned off */
  | { kind: 'missing'; name: string }
  /** Nothing to do (same depth, or already at the top) */
  | null

const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path)
const partsOf = (path: string, separator: string) => path.split(separator).filter(Boolean)

function upLocal(localPath: string, levels: number): string | null {
  if (isWindowsPath(localPath)) {
    const parts = partsOf(localPath, '\\')
    // The drive itself (C:) is never removed
    const remove = Math.min(levels, parts.length - 1)
    return remove > 0 ? parts.slice(0, parts.length - remove).join('\\') + '\\' : null
  }
  const parts = partsOf(localPath, '/')
  const kept = parts.slice(0, parts.length - Math.min(levels, parts.length))
  return kept.length === 0 ? '/' : `/${kept.join('/')}`
}

function upRemote(remotePath: string, levels: number): string {
  const parts = partsOf(remotePath, '/')
  const kept = parts.slice(0, parts.length - Math.min(levels, parts.length))
  return kept.length === 0 ? '/' : `/${kept.join('/')}`
}

function joinLocal(base: string, name: string): string {
  if (isWindowsPath(base)) return base.endsWith('\\') ? `${base}${name}` : `${base}\\${name}`
  return base === '/' ? `/${name}` : `${base}/${name}`
}

const joinRemote = (base: string, name: string) => (base === '/' ? `/${name}` : `${base}/${name}`)
const hasFolder = (files: readonly Entry[], name: string) => files.some(file => file.name === name && file.type === 'directory')

/** The remote list went from `prevRemote` to `nextRemote`: where the local list should go */
export function localFollowsRemote(prevRemote: string, nextRemote: string, localPath: string, localFiles: readonly Entry[]): SyncMove {
  if (prevRemote === nextRemote) return null
  const prevDepth = partsOf(prevRemote, '/').length
  const nextDepth = partsOf(nextRemote, '/').length
  if (nextDepth < prevDepth) {
    const path = upLocal(localPath, prevDepth - nextDepth)
    return path === null ? null : { kind: 'go', path }
  }
  const entered = partsOf(nextRemote, '/').pop()
  if (!entered) return null
  return hasFolder(localFiles, entered) ? { kind: 'go', path: joinLocal(localPath, entered) } : { kind: 'missing', name: entered }
}

/** The local list went from `prevLocal` to `nextLocal`: where the remote list should go */
export function remoteFollowsLocal(prevLocal: string, nextLocal: string, remotePath: string, remoteFiles: readonly Entry[]): SyncMove {
  if (prevLocal === nextLocal) return null
  const separator = isWindowsPath(prevLocal) ? '\\' : '/'
  const prevParts = partsOf(prevLocal, separator)
  const nextParts = partsOf(nextLocal, separator)
  if (nextParts.length < prevParts.length) {
    return { kind: 'go', path: upRemote(remotePath, prevParts.length - nextParts.length) }
  }
  const entered = nextParts[nextParts.length - 1]
  if (!entered) return null
  return hasFolder(remoteFiles, entered) ? { kind: 'go', path: joinRemote(remotePath, entered) } : { kind: 'missing', name: entered }
}
