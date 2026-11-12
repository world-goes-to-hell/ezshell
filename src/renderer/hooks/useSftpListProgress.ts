import { useEffect, useState } from 'react'

/**
 * How many entries of `path` have been read so far, while the folder is being listed (0 before the
 * first report and for small folders). The main process reports as the parts arrive.
 */
export function useSftpListProgress(sessionId: string, path: string, isLoading: boolean): number {
  const [progress, setProgress] = useState<{ path: string; count: number } | null>(null)

  useEffect(() => {
    if (!isLoading) {
      setProgress(null)
      return
    }
    return window.electronAPI.onSftpListProgress?.((data) => {
      if (data.sessionId === sessionId && data.remotePath === path) setProgress({ path, count: data.count })
    })
  }, [sessionId, path, isLoading])

  return isLoading && progress?.path === path ? progress.count : 0
}
