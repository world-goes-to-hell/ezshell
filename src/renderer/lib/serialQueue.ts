// Runs async requests one after another. main answers a DB window one request at a time and refuses
// the rest ("앞의 요청을 처리하는 중"), so the window lines its own requests up instead
// (completion lookups, the schema tree and the query never meet in main).

export interface SerialQueue {
  run: <T>(work: () => Promise<T>) => Promise<T>
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      const next = tail.then(work, work)
      // A failure is the caller's to handle; the next request still runs
      tail = next.catch(() => undefined)
      return next
    }
  }
}
