/** One entry of the `sftp-list` IPC response (only the fields the side explorer uses) */
export interface RemoteListEntry {
  name: string
  isDirectory: boolean
  isSymlink?: boolean
  /** Text the link points to (readlink), when it could be read */
  linkTarget?: string
  /** The link resolves to a directory (stat follows the link) */
  targetIsDirectory?: boolean
  /** The link target does not exist */
  isBrokenLink?: boolean
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  isSymlink: boolean
  linkTarget?: string
  isBrokenLink?: boolean
  children?: FileNode[]
  isLoaded?: boolean
  isExpanded?: boolean
}

const HIDDEN_NAMES = new Set(['.', '..'])

function childPath(dirPath: string, name: string): string {
  return dirPath === '/' ? `/${name}` : `${dirPath}/${name}`
}

/** Tree nodes for the side SFTP explorer; directory links expand like directories. */
export function toFileNodes(entries: RemoteListEntry[], dirPath: string): FileNode[] {
  return entries
    .filter(entry => !HIDDEN_NAMES.has(entry.name))
    .map((entry): FileNode => {
      const isSymlink = Boolean(entry.isSymlink)
      const isDirectory = isSymlink ? Boolean(entry.targetIsDirectory) : entry.isDirectory
      return {
        name: entry.name,
        path: childPath(dirPath, entry.name),
        type: isDirectory ? 'directory' : 'file',
        isSymlink,
        linkTarget: entry.linkTarget,
        isBrokenLink: isSymlink ? Boolean(entry.isBrokenLink) : undefined,
        children: isDirectory ? [] : undefined,
        isLoaded: false,
        isExpanded: false
      }
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}
