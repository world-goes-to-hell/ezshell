// Symlink resolution for SFTP directory listings.
// readdir attrs describe the link itself (lstat), so a link to a directory looks like a plain entry.
// This follows each link once (stat) and reads its target text (readlink) without failing the listing.

const DEFAULT_CONCURRENCY = 16;
// A server that never answers one request must not leave the whole listing loading forever
const DEFAULT_TIMEOUT_MS = 5000;
const TIMED_OUT = Symbol('timed out');

function joinRemotePath(dirPath, name) {
  const base = dirPath.endsWith('/') ? dirPath.slice(0, -1) : dirPath;
  return `${base}/${name}`;
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function resolveOne(dirPath, entry, fsOps, timeoutMs) {
  const fullPath = joinRemotePath(dirPath, entry.name);
  const [statResult, linkResult] = await Promise.allSettled([
    withTimeout(fsOps.stat(fullPath), timeoutMs),
    withTimeout(fsOps.readlink(fullPath), timeoutMs)
  ]);
  const stats = statResult.status === 'fulfilled' && statResult.value !== TIMED_OUT ? statResult.value : null;
  const linkTarget = linkResult.status === 'fulfilled' && linkResult.value !== TIMED_OUT ? linkResult.value : undefined;
  return {
    ...entry,
    linkTarget,
    targetIsDirectory: Boolean(stats && stats.isDirectory()),
    // Only a failed stat means the target is missing; a timeout leaves it unknown
    isBrokenLink: statResult.status === 'rejected'
  };
}

/**
 * @param {string} dirPath remote directory the entries were listed from
 * @param {Array<{ name: string, isSymlink: boolean }>} entries
 * @param {{ stat: (p: string) => Promise<{ isDirectory: () => boolean }>, readlink: (p: string) => Promise<string> }} fsOps
 * @param {number} [concurrency] max links resolved at once (each sends a stat and a readlink)
 * @param {number} [timeoutMs] per-request limit; an unanswered link is returned as unresolved
 * @returns {Promise<Array<object>>} new entries; symlinks gain linkTarget, targetIsDirectory, isBrokenLink
 */
async function resolveSymlinks(dirPath, entries, fsOps, concurrency = DEFAULT_CONCURRENCY, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const result = entries.slice();
  const linkIndexes = entries.map((entry, i) => (entry.isSymlink ? i : -1)).filter(i => i >= 0);
  let next = 0;

  const worker = async () => {
    while (next < linkIndexes.length) {
      const index = linkIndexes[next++];
      result[index] = await resolveOne(dirPath, entries[index], fsOps, timeoutMs);
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), linkIndexes.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return result;
}

module.exports = { resolveSymlinks, joinRemotePath };
