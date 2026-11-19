// Which folders on this PC the workspace panel may read files from
// (docs/plan/2026-11-19-workspace-files-and-git-details.md). The window does not choose freely:
// a root is accepted when it is, or is inside, a folder main already knows: the folder an open local
// shell started in, that folder's Git repository, or a worktree of that repository.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const fs = require('fs')
const path = require('path')
const { isLocalFilePath } = require('../localKeyPath.js')

const MESSAGES = {
  root: '이 폴더는 작업 공간에서 열 수 없습니다 (열려 있는 로컬 터미널의 폴더나 그 Git 저장소만).',
  path: '열 수 없는 경로입니다.',
  outside: '작업 폴더 밖의 파일은 열 수 없습니다.'
}

class LocalPathError extends Error {
  constructor(userMessage) {
    super(userMessage)
    this.userMessage = userMessage
  }
}

const REPO_CACHE_MS = 10000
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const sameOrInside = (parent, child) => {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
const key = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)

async function realDirectory(value) {
  if (typeof value !== 'string' || !isLocalFilePath(value) || CONTROL.test(value)) throw new LocalPathError(MESSAGES.root)
  try {
    const real = await fs.promises.realpath(path.normalize(value))
    if (!(await fs.promises.stat(real)).isDirectory()) throw new LocalPathError(MESSAGES.root)
    return real
  } catch (error) {
    throw error instanceof LocalPathError ? error : new LocalPathError(MESSAGES.root)
  }
}

/**
 * `knownFolders()` gives (or resolves with) the folders main knows: the open local shells' start and
 * current folders.
 * `repoFolders(folder)` gives the repository top and its worktrees for a folder ([] outside Git).
 */
function createLocalRoots({ knownFolders, repoFolders, now = Date.now }) {
  // A folder's repository and worktrees, asked of Git at most every 10 seconds (each request checks)
  const repoCache = new Map()
  async function repoFoldersOf(folder) {
    const cached = repoCache.get(folder)
    if (cached && now() - cached.at < REPO_CACHE_MS) return cached.list
    const list = await repoFolders(folder).catch(() => [])
    repoCache.set(folder, { at: now(), list })
    if (repoCache.size > 50) repoCache.delete(repoCache.keys().next().value)
    return list
  }

  async function allowed() {
    const folders = new Set()
    for (const folder of await knownFolders()) {
      if (typeof folder !== 'string' || !isLocalFilePath(folder)) continue
      const real = await fs.promises.realpath(folder).catch(() => null)
      if (!real) continue
      folders.add(real)
      for (const extra of await repoFoldersOf(real)) {
        const resolved = await fs.promises.realpath(extra).catch(() => null)
        if (resolved) folders.add(resolved)
      }
    }
    return [...folders]
  }

  /** The real path of an accepted root; a LocalPathError otherwise */
  async function resolveRoot(root) {
    const real = await realDirectory(root)
    const known = await allowed()
    if (!known.some(folder => sameOrInside(key(folder), key(real)))) throw new LocalPathError(MESSAGES.root)
    return real
  }

  /**
   * A path inside an accepted root, given relative to it ('' is the root itself). Links are followed
   * and the real path must still be inside the root.
   */
  async function resolveInside(root, relative) {
    const base = await resolveRoot(root)
    if (typeof relative !== 'string' || CONTROL.test(relative) || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
      throw new LocalPathError(MESSAGES.path)
    }
    const joined = path.join(base, relative)
    let real
    try {
      real = await fs.promises.realpath(joined)
    } catch {
      throw new LocalPathError(MESSAGES.path)
    }
    if (!sameOrInside(key(base), key(real))) throw new LocalPathError(MESSAGES.outside)
    return { root: base, path: real, relative: path.relative(base, real) }
  }

  return { resolveRoot, resolveInside }
}

module.exports = { createLocalRoots, LocalPathError, MESSAGES, sameOrInside }
