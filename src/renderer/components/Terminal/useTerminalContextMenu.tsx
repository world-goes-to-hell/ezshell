import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Terminal } from 'xterm'
import {
  RiLayoutColumnLine, RiSplitCellsHorizontal, RiSplitCellsVertical, RiLayoutGridLine,
  RiLayoutLine, RiMagicLine, RiFileSearchLine, RiSearchLine, RiFindReplaceLine, RiFolderLine, RiCodeSSlashLine,
  RiTerminalBoxLine, RiFileCopy2Line, RiRecordCircleLine, RiStopCircleLine, RiFolderTransferLine, RiCloseCircleLine, RiFolderSharedLine, RiAddLine, RiSettings3Line, RiCheckboxBlankLine
} from 'react-icons/ri'
import { useTerminalStore } from '../../stores/terminalStore'
import { useSessionLogStore } from '../../stores/sessionLogStore'
import { useSftpStore } from '../../stores/sftpStore'
import { toggleSessionLog } from '../../lib/sessionLogActions'
import { useSnippetStore } from '../../stores/snippetStore'
import { findQueryFromSelection } from '../../lib/terminalText'
import { syncSftpToTerminal } from '../../lib/sftpSync'
import { terminalPaneAt } from '../../lib/terminalPanes'
import { FIND_QUERY_MAX_LENGTH, type FindKind } from '../../lib/terminalFind'
import { commonTerminalItems } from './terminalMenuCommon'
import { TerminalContextMenu, MENU_SEPARATOR, type TerminalMenuGroup, type TerminalMenuItem } from './TerminalContextMenu'
import { fileZoneOf, isFileZoneShown, setFileZoneShown } from './terminalFileZone'
import { SnippetModal } from '../Snippets/SnippetModal'
import { findTarget, nameAtPointer, targetHint, targetItems, type TerminalTarget } from './terminalTargetMenu'
import { TerminalFindDialog } from './TerminalFindDialog'

/** Snippets listed in the menu; the rest are in the snippet manager */
const MAX_SNIPPETS_IN_MENU = 15

/** How long the menu waits for the server to say what the right-clicked name is, before opening without it */
const TARGET_WAIT_MS = 400

/** App.tsx opens the snippet manager when it hears this */
export const OPEN_SNIPPET_MANAGER_EVENT = 'ezshell:open-snippet-manager'

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
  const [menu, setMenu] = useState<{ x: number; y: number; terminal: Terminal; target: TerminalTarget | null } | null>(null)
  // Only the latest right-click may open the menu (an earlier one may still be asking the server)
  const requestRef = useRef(0)
  const [find, setFind] = useState<{ kind: FindKind; terminal: Terminal; query: string } | null>(null)
  const snippets = useSnippetStore(state => state.snippets)
  // A new snippet being written from the menu (its command starts as the selected text)
  const [snippetDraft, setSnippetDraft] = useState<{ command: string; terminal: Terminal } | null>(null)
  const tab = useTerminalStore(state => state.terminals.get(sessionId))
  const setSplit = useTerminalStore(state => state.setSplit)
  const isLogging = useSessionLogStore(state => sessionId in state.files)
  const isSftpOpen = useSftpStore(state => state.isOpen(sessionId))

  const onContextMenu = useCallback((event: MouseEvent) => {
    // Panels drawn over the terminal area (port forwarding, monitor) keep the default behaviour
    const terminal = terminalPaneAt(event.target)
    if (!terminal) return
    event.preventDefault()
    const at = { x: event.clientX, y: event.clientY, terminal }
    const request = ++requestRef.current
    const name = nameAtPointer(terminal, event.clientX, event.clientY)
    if (!name) {
      setMenu({ ...at, target: null })
      return
    }
    // The folder is known for the tab's main terminal only (read from its prompt); a split shell
    // is in a folder of its own, so only absolute paths are looked up there
    const isSplitShell = event.target instanceof Element && event.target.closest('.split-terminal') !== null
    const cwd = isSplitShell ? undefined : useTerminalStore.getState().terminals.get(sessionId)?.currentPath
    // The menu opens once, with the file's actions already in it: adding them afterwards would move
    // the items under the pointer. A server that takes too long gets the plain menu.
    const wait = new Promise<null>(resolve => { window.setTimeout(() => resolve(null), TARGET_WAIT_MS) })
    void Promise.race([findTarget(sessionId, name, cwd), wait]).then((target) => {
      if (requestRef.current === request) setMenu({ ...at, target })
    })
  }, [sessionId])

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
    const tabName = tab ? (tab.title || `${tab.username}@${tab.host}`) : 'terminal'
    const { top, output } = commonTerminalItems(terminal, tabName, then)
    // A selected word or path is what the find dialogs start with
    const query = findQueryFromSelection(selection, FIND_QUERY_MAX_LENGTH)
    // Typed into the input line like the find commands, not run: the user presses Enter
    const snippetItems: TerminalMenuItem[] = snippets.slice(0, MAX_SNIPPETS_IN_MENU).map(snippet => ({
      label: snippet.name,
      icon: RiCodeSSlashLine,
      onSelect: then(() => terminal.paste(useSnippetStore.getState().expandVariables(snippet.command, {
        user: tab?.username ?? '', host: tab?.host ?? '', path: tab?.currentPath || '~'
      })))
    }))
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
          { label: '이름 찾기…', icon: RiFileSearchLine, onSelect: () => setFind({ kind: 'name', terminal, query }) },
          { label: '내용 찾기…', icon: RiSearchLine, onSelect: () => setFind({ kind: 'content', terminal, query }) },
          { label: '화면에서 찾기', icon: RiFindReplaceLine, onSelect: onOpenSearch },
          MENU_SEPARATOR,
          ...output,
          MENU_SEPARATOR,
          { label: 'SFTP 를 현재 폴더로', icon: RiFolderSharedLine, onSelect: then(() => void syncSftpToTerminal(sessionId)) },
          { label: isFileExplorerOpen ? '파일 탐색기 닫기' : '파일 탐색기 열기', icon: RiFolderLine, onSelect: then(onToggleFileExplorer) },
          // Only the tab's main terminal has a file zone (a split shell's folder is not known)
          ...(fileZoneOf(terminal) ? [{
            label: isFileZoneShown() ? '파일 영역 테두리 끄기' : '파일 영역 테두리 켜기',
            icon: RiCheckboxBlankLine,
            onSelect: then(() => setFileZoneShown(!isFileZoneShown()))
          }] : [])
        ]
      },
      {
        label: '스니펫',
        icon: RiCodeSSlashLine,
        items: [
          ...snippetItems,
          ...(snippetItems.length > 0 ? [MENU_SEPARATOR] : []),
          {
            label: selection.trim() ? '선택한 내용을 스니펫으로 추가…' : '스니펫 추가…',
            icon: RiAddLine,
            // Opened after this click has ended: the form closes on a click outside it, and the click that
            // chose this item would land on the form's backdrop once the menu is gone
            onSelect: () => { window.setTimeout(() => setSnippetDraft({ command: selection.trim(), terminal }), 0) }
          },
          { label: '스니펫 관리…', icon: RiSettings3Line, onSelect: () => window.dispatchEvent(new CustomEvent(OPEN_SNIPPET_MANAGER_EVENT)) }
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
            onSelect: then(() => void toggleSessionLog(sessionId, tab ? tabName : ''))
          },
          { label: isSftpOpen ? 'SFTP 닫기' : 'SFTP 열기', icon: RiFolderTransferLine, onSelect: then(() => useSftpStore.getState().setOpen(sessionId, !isSftpOpen)) },
          MENU_SEPARATOR,
          { label: '연결 종료', icon: RiCloseCircleLine, onSelect: onCloseSession }
        ]
      }
    ]
    const target = menu.target
      ? { name: menu.target.name, hint: targetHint(menu.target), items: targetItems(sessionId, tabName, menu.target, terminal, then) }
      : undefined
    contextMenu = <TerminalContextMenu key={`${menu.x}:${menu.y}`} position={menu} target={target} top={top} groups={groups} onClose={() => setMenu(null)} />
  }

  return {
    onContextMenu,
    contextMenu: (
      <>
        {contextMenu}
        {snippetDraft && createPortal(
          <SnippetModal
            snippetId={null}
            initialCommand={snippetDraft.command}
            onClose={() => {
              const { terminal } = snippetDraft
              setSnippetDraft(null)
              window.setTimeout(() => terminal.focus(), 0)
            }}
          />,
          document.body
        )}
        {find && (
          <TerminalFindDialog
            kind={find.kind}
            initialQuery={find.query}
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
