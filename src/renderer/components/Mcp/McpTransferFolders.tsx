import { RiDeleteBinLine, RiFolderAddLine } from 'react-icons/ri'
import type { McpStatusResult } from '../../types'

interface McpTransferFoldersProps {
  folders: string[]
  disabled: boolean
  /** Runs a settings change and applies the status it answers with; false when it failed or was skipped */
  onChange: (task: () => Promise<McpStatusResult>) => Promise<boolean>
}

const NOT_SUPPORTED: McpStatusResult = { success: false, error: '앱을 다시 시작하면 사용할 수 있습니다.' }

/**
 * Folders on this PC that upload_file / download_file may read and write. A folder is picked in a
 * dialog of the main process; this component never sends a path to add.
 */
export function McpTransferFolders({ folders, disabled, onChange }: McpTransferFoldersProps) {
  const api = window.electronAPI

  const add = () => {
    void onChange(async () => {
      if (typeof api?.mcpAddTransferFolder !== 'function') return NOT_SUPPORTED
      const result = await api.mcpAddTransferFolder()
      if (result.success || !('cancelled' in result)) return result
      // The dialog was closed: nothing changed, so hand back the current status instead of an error
      return typeof api.mcpGetStatus === 'function' ? api.mcpGetStatus() : NOT_SUPPORTED
    })
  }

  const remove = (folder: string) => {
    void onChange(async () => (typeof api?.mcpRemoveTransferFolder === 'function' ? api.mcpRemoveTransferFolder(folder) : NOT_SUPPORTED))
  }

  return (
    <div className="mcp-field">
      <span className="mcp-field-label">파일 전송 허용 폴더</span>
      {folders.length === 0 ? (
        <p className="mcp-transfer-empty">등록된 폴더가 없습니다. 폴더를 추가하기 전에는 Claude Code 가 파일을 올리거나 내려받을 수 없습니다.</p>
      ) : (
        <ul className="mcp-transfer-folders">
          {folders.map(folder => (
            <li key={folder} className="mcp-transfer-folder">
              <code>{folder}</code>
              <button type="button" className="mcp-icon-btn" onClick={() => remove(folder)} disabled={disabled} aria-label={`${folder} 삭제`} title="삭제">
                <RiDeleteBinLine size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn-secondary mcp-transfer-add" onClick={add} disabled={disabled}>
        <RiFolderAddLine size={16} /> 폴더 추가
      </button>
      <p className="form-hint">
        Claude Code 의 upload_file, download_file 도구는 이 폴더 안의 파일만 읽고 쓸 수 있습니다. 전송할 때마다 확인 창에서 양쪽 경로를 보여 주고 허용을 받습니다.
        앱의 데이터 폴더를 포함하는 폴더(드라이브 C 전체, 홈 폴더 전체 등)는 등록할 수 없습니다.
      </p>
    </div>
  )
}
