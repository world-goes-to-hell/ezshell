import { useCallback, useState, type MouseEvent, type ReactNode } from 'react'
import type { Terminal } from 'xterm'
import {
  RiFileCopyLine, RiClipboardLine, RiLayoutColumnLine, RiSplitCellsHorizontal, RiSplitCellsVertical, RiLayoutGridLine,
  RiLayoutLine, RiMagicLine, RiFileSearchLine, RiSearchLine, RiFindReplaceLine, RiEraserLine, RiFolderLine,
  RiTerminalBoxLine, RiFileCopy2Line, RiRecordCircleLine, RiStopCircleLine, RiFolderTransferLine, RiCloseCircleLine
} from 'react-icons/ri'
import { useTerminalStore } from '../../stores/terminalStore'
import { useSessionLogStore } from '../../stores/sessionLogStore'
import { useSftpStore } from '../../stores/sftpStore'
import { toggleSessionLog } from '../../lib/sessionLogActions'
import { copyToClipboard } from '../../lib/terminalClipboard'
import { terminalPaneAt } from '../../lib/terminalPanes'
import { toast } from '../../stores/toastStore'
import type { FindKind } from '../../lib/terminalFind'
import { TerminalContextMenu, type TerminalMenuGroup, type TerminalMenuItem } from './TerminalContextMenu'
import { TerminalFindDialog } from './TerminalFindDialog'

/** App.tsx opens another tab to the same server when it hears this (detail: the tab's id) */
export const DUPLICATE_TAB_EVENT = 'ezshell:duplicate-tab'

interface Options {
  sessionId: string
  isFileExplorerOpen: boolean
  onToggleFileExplorer: () => void
  onOpenSearch: () => void
  /** Ends the connection and closes the tab */
  onCloseSession: () => void
}

/**
 * Right-click menu of a tab's terminals (the main one and the split shells): copy / paste on top,
 * then 분할, 편의 and 세션 submenus. Copy, paste, clear and the find commands act on the terminal
 * that was clicked; the rest act on the tab.
 */
export function useTerminalContextMenu({ sessionId, isFileExplorerOpen, onToggleFileExplorer, onOpenSearch, onCloseSession }: Options): {
  onContextMenu: (event: MouseEvent) => void
  contextMenu: ReactNode
} {
  const [menu, setMenu] = useState<{ x: number; y: number; terminal: Terminal } | null>(null)
  const [find, setFind] = useState<{ kind: FindKind; terminal: Terminal } | null>(null)
  const tab = useTerminalStore(state => state.terminals.get(sessionId))
  const setSplit = useTerminalStore(state => state.setSplit)
  const isLogging = useSessionLogStore(state => sessionId in state.files)
  const isSftpOpen = useSftpStore(state => state.isOpen(sessionId))

  const onContextMenu = useCallback((event: MouseEvent) => {
    // Panels drawn over the terminal area (port forwarding, monitor) keep the default behaviour
    const terminal = terminalPaneAt(event.target)
    if (!terminal) return
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, terminal })
  }, [])

  let contextMenu: ReactNode = null
  if (menu) {
    const { terminal } = menu
    const selection = terminal.getSelection()
    const isSplit = tab?.isSplit === true
    // Runs after the menu has closed, so the keyboard ends up in the terminal that was clicked
    const then = (action: () => void) => () => {
      action()
      window.setTimeout(() => terminal.focus(), 0)
    }
    const paste = async (): Promise<void> => {
      try {
        const text = await navigator.clipboard.readText()
        if (text) terminal.paste(text)
      } catch {
        toast.error('붙여넣기 실패', '클립보드에 접근할 수 없습니다')
      }
    }
    const top: TerminalMenuItem[] = [
      { label: '복사', icon: RiFileCopyLine, disabled: !selection, onSelect: then(() => void copyToClipboard(selection)) },
      { label: '붙여넣기', icon: RiClipboardLine, onSelect: then(() => void paste()) }
    ]
    const groups: TerminalMenuGroup[] = [
      {
        label: '분할',
        icon: RiLayoutColumnLine,
        items: [
          { label: '좌우 분할', icon: RiSplitCellsHorizontal, onSelect: then(() => setSplit(sessionId, true, 'horizontal')) },
          { label: '상하 분할', icon: RiSplitCellsVertical, onSelect: then(() => setSplit(sessionId, true, 'vertical')) },
          { label: '4분할', icon: RiLayoutGridLine, onSelect: then(() => setSplit(sessionId, true, 'quad')) },
          { label: '분할 해제', icon: RiLayoutLine, disabled: !isSplit, onSelect: then(() => setSplit(sessionId, false)) }
        ]
      },
      {
        label: '편의',
        icon: RiMagicLine,
        items: [
          { label: '이름 찾기…', icon: RiFileSearchLine, onSelect: () => setFind({ kind: 'name', terminal }) },
          { label: '내용 찾기…', icon: RiSearchLine, onSelect: () => setFind({ kind: 'content', terminal }) },
          { label: '화면에서 찾기', icon: RiFindReplaceLine, onSelect: onOpenSearch },
          { label: '화면 지우기', icon: RiEraserLine, onSelect: then(() => terminal.clear()) },
          { label: isFileExplorerOpen ? '파일 탐색기 닫기' : '파일 탐색기 열기', icon: RiFolderLine, onSelect: then(onToggleFileExplorer) }
        ]
      },
      {
        label: '세션',
        icon: RiTerminalBoxLine,
        items: [
          { label: '탭 복제', icon: RiFileCopy2Line, onSelect: () => window.dispatchEvent(new CustomEvent(DUPLICATE_TAB_EVENT, { detail: sessionId })) },
          {
            label: isLogging ? '로그 저장 중지' : '로그 저장 시작',
            icon: isLogging ? RiStopCircleLine : RiRecordCircleLine,
            onSelect: then(() => void toggleSessionLog(sessionId, tab ? (tab.title || `${tab.username}@${tab.host}`) : ''))
          },
          { label: isSftpOpen ? 'SFTP 닫기' : 'SFTP 열기', icon: RiFolderTransferLine, onSelect: then(() => useSftpStore.getState().setOpen(sessionId, !isSftpOpen)) },
          { label: '연결 종료', icon: RiCloseCircleLine, onSelect: onCloseSession }
        ]
      }
    ]
    contextMenu = <TerminalContextMenu key={`${menu.x}:${menu.y}`} position={menu} top={top} groups={groups} onClose={() => setMenu(null)} />
  }

  return {
    onContextMenu,
    contextMenu: (
      <>
        {contextMenu}
        {find && (
          <TerminalFindDialog
            kind={find.kind}
            onClose={() => {
              const { terminal } = find
              setFind(null)
              window.setTimeout(() => terminal.focus(), 0)
            }}
            onInsert={(command) => {
              const { terminal } = find
              setFind(null)
              // Typed into the input line like a paste, without a line break: the user presses Enter
              terminal.paste(command)
              window.setTimeout(() => terminal.focus(), 0)
            }}
          />
        )}
      </>
    )
  }
}
