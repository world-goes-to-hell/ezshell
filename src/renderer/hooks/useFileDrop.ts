import { useState, type DragEvent } from 'react'
import { droppedFilePaths } from '../lib/droppedFiles'
import { toast } from '../stores/toastStore'

/** The quoting a dropped path gets (lib/droppedFiles.ts terminalDropText): this PC's shell */
export const dropPlatform = (): 'win32' | 'posix' => (/^win/i.test(navigator.platform) ? 'win32' : 'posix')

/**
 * Files dragged from the file manager onto an element (2026-11-27 user request: a local terminal and its
 * chat take dropped files). Only file drags: the app's own drags (tabs, panes, agent sessions) carry no
 * files and pass by. `onPaths` gets the dropped files' paths on this PC.
 */
export function useFileDrop(onPaths: (paths: string[]) => void, enabled: boolean) {
  const [dropping, setDropping] = useState(false)
  const accepts = (event: DragEvent) => enabled && Array.from(event.dataTransfer.types).includes('Files')
  return {
    dropping: dropping && enabled,
    handlers: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!accepts(event)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
        if (!dropping) setDropping(true)
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false)
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        setDropping(false)
        if (!accepts(event)) return
        event.preventDefault()
        event.stopPropagation()
        const { paths, missing } = droppedFilePaths(Array.from(event.dataTransfer.files), window.electronAPI.getPathForFile)
        if (missing > 0) toast.error('일부 파일을 넣지 못했습니다', `${missing}개 파일은 이 PC 의 위치를 알 수 없습니다.`)
        if (paths.length) onPaths(paths.map(item => item.localPath))
      }
    }
  }
}
