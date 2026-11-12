import type { Terminal } from 'xterm'
import { RiFileCopyLine, RiClipboardLine, RiCheckboxMultipleLine, RiEraserLine, RiFileList2Line, RiSave3Line } from 'react-icons/ri'
import { copyToClipboard } from '../../lib/terminalClipboard'
import { bufferText, outputFileName } from '../../lib/terminalText'
import { toast } from '../../stores/toastStore'
import type { TerminalMenuItem } from './TerminalContextMenu'

async function paste(terminal: Terminal): Promise<void> {
  try {
    const text = await navigator.clipboard.readText()
    if (text) terminal.paste(text)
  } catch {
    toast.error('붙여넣기 실패', '클립보드에 접근할 수 없습니다')
  }
}

async function saveOutput(terminal: Terminal, tabName: string): Promise<void> {
  const text = bufferText(terminal.buffer.active)
  if (!text) {
    toast.info('저장할 출력이 없습니다')
    return
  }
  const result = await window.electronAPI.saveTerminalOutput?.(outputFileName(tabName, new Date()), text)
  if (!result) toast.error('출력 저장 실패', '앱을 다시 시작해 주세요.')
  else if (result.success) toast.success('출력을 저장했습니다', result.filePath)
  else if (!result.cancelled) toast.error('출력 저장 실패', result.error)
}

/**
 * Menu items every terminal has (SSH tabs, split shells, local terminals). `then` wraps an action so
 * the keyboard goes back to the terminal after the menu closes.
 */
export function commonTerminalItems(terminal: Terminal, tabName: string, then: (action: () => void) => () => void): {
  top: TerminalMenuItem[]
  output: TerminalMenuItem[]
} {
  const selection = terminal.getSelection()
  return {
    top: [
      { label: '복사', icon: RiFileCopyLine, disabled: !selection, onSelect: then(() => void copyToClipboard(selection)) },
      { label: '붙여넣기', icon: RiClipboardLine, onSelect: then(() => void paste(terminal)) },
      { label: '모두 선택', icon: RiCheckboxMultipleLine, onSelect: then(() => terminal.selectAll()) }
    ],
    output: [
      { label: '화면 지우기', icon: RiEraserLine, onSelect: then(() => terminal.clear()) },
      {
        label: '전체 출력 복사',
        icon: RiFileList2Line,
        onSelect: then(() => {
          const text = bufferText(terminal.buffer.active)
          if (text) void copyToClipboard(text)
          else toast.info('복사할 출력이 없습니다')
        })
      },
      { label: '출력을 파일로 저장…', icon: RiSave3Line, onSelect: then(() => void saveOutput(terminal, tabName)) }
    ]
  }
}
