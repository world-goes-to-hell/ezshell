const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads')

const INVALID_PATTERN = '올바른 정규식이 아닙니다. 괄호나 특수 문자를 확인해 주세요.'
const MATCH_LIMIT = 40

function compileSearchPattern(query, caseSensitive) {
  try {
    return new RegExp(query, caseSensitive ? 'gu' : 'giu')
  } catch {
    throw new Error(INVALID_PATTERN)
  }
}

function matchRanges(text, pattern) {
  const ranges = []
  let at = null
  let count = 0
  for (const match of text.matchAll(pattern)) {
    at ??= match.index
    if (match[0].length) ranges.push([match.index, match.index + match[0].length])
    if (++count >= MATCH_LIMIT) break
  }
  return at === null ? null : { at, ranges }
}

function searchPaths({ paths, query, limit }) {
  const pattern = compileSearchPattern(query, false)
  const entries = []
  for (const path of paths) {
    const match = matchRanges(path, pattern)
    if (!match) continue
    if (entries.length >= limit) return { entries, truncated: true }
    entries.push({ path, name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', ranges: match.ranges })
  }
  return { entries, truncated: false }
}

// An expensive match must be interruptible without blocking Electron or running the pattern in React.
async function runRegexSearch(task, { signal, timeout }) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: task })
    let finished = false
    const onAbort = () => finish(signal.reason)
    const timer = setTimeout(() => finish(new Error('정규식 검색 시간이 초과됐습니다. 패턴이나 범위를 좁혀 주세요.')), timeout)
    function finish(error, result) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      if (error) reject(error)
      else resolve(result)
    }
    worker.once('message', ({ error, result }) => finish(error ? new Error(error) : null, result))
    worker.once('error', finish)
    worker.once('exit', () => finish(new Error('정규식 검색을 완료하지 못했습니다.')))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

module.exports = { runRegexSearch, compileSearchPattern, matchRanges }

if (!isMainThread && workerData?.type) {
  Promise.resolve().then(() => workerData.type === 'paths'
    ? searchPaths(workerData)
    : require('./contentSearch.js').scanContent(workerData))
    .then(result => parentPort.postMessage({ result }), error => parentPort.postMessage({ error: error.message }))
}
