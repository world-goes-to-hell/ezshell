// Tree edits for the terminal's side file explorer after a context menu action (rename, new folder,
// delete): only the folder that changed is read again, so the rest of the tree keeps its open folders.
import type { FileNode } from './fileExplorerNodes'
import type { FileItem } from '../stores/sftpStore'

/** "/var/log/app.log" → "/var/log", "/etc" → "/" */
export function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
  return at <= 0 ? '/' : trimmed.slice(0, at)
}

/**
 * The tree with the folder at `dirPath` holding `children` (and open), without changing the given
 * tree. Folders inside it that were open stay open when they are still there.
 */
export function replaceChildren(nodes: FileNode[], dirPath: string, children: FileNode[]): FileNode[] {
  return nodes.map(node => {
    if (node.type !== 'directory') return node
    if (node.path === dirPath) {
      const before = new Map((node.children ?? []).map(child => [child.path, child]))
      const kept = children.map(child => {
        const old = before.get(child.path)
        return old && old.type === child.type ? { ...child, isExpanded: old.isExpanded, isLoaded: old.isLoaded, children: old.children } : child
      })
      return { ...node, children: kept, isLoaded: true, isExpanded: true }
    }
    if (dirPath.startsWith(node.path === '/' ? '/' : `${node.path}/`) && node.children) {
      return { ...node, children: replaceChildren(node.children, dirPath, children) }
    }
    return node
  })
}

/** The same top level after reading it again: folders that were open keep their contents */
export function mergeRoot(oldNodes: FileNode[], fresh: FileNode[]): FileNode[] {
  const before = new Map(oldNodes.map(node => [node.path, node]))
  return fresh.map(node => {
    const old = before.get(node.path)
    return old && old.type === node.type ? { ...node, isExpanded: old.isExpanded, isLoaded: old.isLoaded, children: old.children } : node
  })
}

/** What the SFTP list's context menu needs to know about a tree node */
export function toFileItem(node: FileNode): FileItem {
  return { name: node.name, type: node.type, size: node.size ?? 0, modifyTime: 0 }
}
