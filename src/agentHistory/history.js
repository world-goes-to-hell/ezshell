const fs = require('fs')
const os = require('os')
const path = require('path')
const claude = require('./claude.js')
const codex = require('./codex.js')
const { LIMITS, isUuid, oneLine } = require('./common.js')
const { isLocalFilePath } = require('../localKeyPath.js')
const { searchWords, searchFile } = require('./search.js')

// Past Claude Code and Codex sessions of this PC, read from the transcripts the CLIs leave behind.
// The window gets summaries and opaque keys only: the file paths stay here, and resuming takes a key
// so a window cannot make the app run an agent with a session id or folder of its choosing.

const READERS = { claude, codex }
const MAX_FILES = 500
const PARALLEL = 4

/** An absolute folder from the environment, or null (a relative one would depend on our cwd) */
const envFolder = value => (typeof value === 'string' && value && path.isAbsolute(value) ? value : null)

function agentRoots(env, homeDir) {
  return {
    claude: envFolder(env.CLAUDE_CONFIG_DIR) ?? path.join(homeDir, '.claude'),
    codex: envFolder(env.CODEX_HOME) ?? path.join(homeDir, '.codex')
  }
}

async function eachLimited(items, limit, run) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      await run(items[index], index)
    }
  })
  await Promise.all(workers)
}

function createAgentHistory({ env = process.env, homeDir = os.homedir() } = {}) {
  // file → { size, mtimeMs, summary }: a file is read again only when it changed
  let cache = new Map()
  // key → { agent, id, file, cwd }, from the latest list
  let entries = new Map()
  let running = null
  // Bumped by clear(): a scan that started before it must not put back what was forgotten
  let generation = 0
  // Bumped by each content search: a newer search stops the one still running
  let searchRun = 0

  async function collect() {
    const started = generation
    const roots = agentRoots(env, homeDir)
    const found = []
    for (const agent of Object.keys(READERS)) {
      for (const file of await READERS[agent].listFiles(roots[agent])) found.push({ agent, file })
    }
    const stats = await Promise.all(found.map(async item => {
      try {
        const stat = await fs.promises.stat(item.file)
        return stat.isFile() ? { ...item, size: stat.size, mtimeMs: stat.mtimeMs } : null
      } catch {
        return null
      }
    }))
    const files = stats.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)
    const recent = files.slice(0, MAX_FILES)
    const names = await codex.readThreadNames(roots.codex)

    const nextCache = new Map()
    const summaries = new Array(recent.length).fill(null)
    await eachLimited(recent, PARALLEL, async (item, index) => {
      const known = cache.get(item.file)
      let summary = known && known.size === item.size && known.mtimeMs === item.mtimeMs ? known.summary : undefined
      if (summary === undefined) {
        try {
          summary = await READERS[item.agent].summarize(item.file)
        } catch {
          summary = null
        }
      }
      nextCache.set(item.file, { size: item.size, mtimeMs: item.mtimeMs, summary })
      summaries[index] = summary && { ...summary, updated: item.mtimeMs, file: item.file }
    })
    if (started !== generation) return { sessions: [], total: 0, truncated: false }
    cache = nextCache

    const nextEntries = new Map()
    const sessions = []
    for (const summary of summaries) {
      if (!summary || !isUuid(summary.id)) continue
      const key = `${summary.agent}:${summary.id.toLowerCase()}`
      // The same session can be in two files (Codex keeps a copy while compressing): the newest wins
      if (nextEntries.has(key)) continue
      const { file, ...shown } = summary
      nextEntries.set(key, { agent: summary.agent, id: summary.id, file, cwd: summary.cwd })
      const named = summary.agent === 'codex' ? names.get(summary.id.toLowerCase()) : null
      sessions.push({ ...shown, key, title: named ? oneLine(named, LIMITS.title) : shown.title })
    }
    entries = nextEntries
    return { sessions, total: files.length, truncated: files.length > MAX_FILES }
  }

  return {
    /** Summaries, newest first. Calls made while a scan runs share it. */
    list() {
      running ??= collect().finally(() => { running = null })
      return running
    },
    /** First prompt and the latest turns of one session from the latest list, or null */
    async detail(key) {
      const entry = entries.get(key)
      if (!entry) return null
      return READERS[entry.agent].detail(entry.file)
    },
    /**
     * What resuming and opening the folder need, or null when the key is unknown or the folder is not
     * on this PC: looking at `\\host\share` makes Windows send the user's credentials to that host.
     */
    target(key) {
      const entry = entries.get(key)
      if (!entry || !isUuid(entry.id) || !isLocalFilePath(entry.cwd)) return null
      return { agent: entry.agent, id: entry.id, cwd: entry.cwd }
    },
    /**
     * Sessions of the latest list whose questions and answers hold every word, newest first, each with
     * a one-line excerpt (src/agentHistory/search.js). Null when a newer search or clear() stopped it.
     */
    async search(query) {
      const words = searchWords(query)
      const run = ++searchRun
      const started = generation
      if (words.length === 0) return { matches: [] }
      const stopped = () => run !== searchRun || started !== generation
      const items = [...entries.entries()].map(([key, entry]) => ({ key, agent: entry.agent, file: entry.file }))
      const hits = new Array(items.length).fill(null)
      await eachLimited(items, PARALLEL, async (item, index) => {
        if (stopped()) return
        try {
          const hit = await searchFile(item.agent, item.file, words, stopped)
          if (hit) hits[index] = { key: item.key, snippet: hit.snippet }
        } catch {
          // An unreadable transcript is simply not a match
        }
      })
      if (stopped()) return null
      return { matches: hits.filter(Boolean) }
    },
    /** Forget what was read (app lock): summaries hold the start of conversations */
    clear() {
      generation++
      cache = new Map()
      entries = new Map()
    }
  }
}

module.exports = { createAgentHistory, agentRoots, MAX_FILES }
