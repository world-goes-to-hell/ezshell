import { useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiDownload2Line, RiFileCopyLine, RiShareForwardBoxLine } from 'react-icons/ri'
import {
  EXPORT_FORMATS, exportFileName, exportText, parseExportPrefs, xlsxBytes, type ExportFormat, type ExportOptions, type ExportPrefs
} from '../../lib/dbExport'
import { copyToClipboard } from '../../lib/terminalClipboard'
import { toast } from '../../stores/toastStore'
import type { DbQueryResult } from '../../types/db'

const PREFS_KEY = 'dbExportPrefs'
/** Rows shown in the preview (the whole result is written out) */
const PREVIEW_ROWS = 5
// Spreadsheet programs read a UTF-8 file as the local code page without this mark (Korean breaks)
const UTF8_MARK = '﻿'

function readPrefs(): ExportPrefs {
  try {
    return parseExportPrefs(localStorage.getItem(PREFS_KEY))
  } catch {
    return parseExportPrefs(null)
  }
}

interface DbExportDialogProps {
  result: DbQueryResult
  /** The table the query read, when it could be told: names the file and the INSERT statements */
  table: string
  engine: string
  onClose: () => void
}

/**
 * "추출": writes the result shown in the grid in a chosen format, to a file or the clipboard.
 * Nothing is asked from the database again: what was received (at most 1,000 rows) is written out.
 */
export function DbExportDialog({ result, table, engine, onClose }: DbExportDialogProps) {
  const [prefs, setPrefs] = useState(readPrefs)
  const [tableName, setTableName] = useState(table)
  const [isSaving, setIsSaving] = useState(false)
  const info = EXPORT_FORMATS.find(item => item.format === prefs.format) ?? EXPORT_FORMATS[0]
  const options: ExportOptions = { includeHeader: prefs.includeHeader, tableName: tableName.trim(), engine }
  const { columns, rows } = result

  const change = (next: Partial<ExportPrefs>): void => {
    const merged = { ...prefs, ...next }
    setPrefs(merged)
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(merged))
    } catch {
      // Only a convenience
    }
  }

  const preview = useMemo(
    () => (info.format === 'xlsx' ? null : exportText(info.format, columns, rows.slice(0, PREVIEW_ROWS), options).trimEnd()),
    // options is rebuilt every render; its parts are listed
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [info.format, columns, rows, prefs.includeHeader, options.tableName, engine]
  )

  const copy = async (): Promise<void> => {
    if (info.format === 'xlsx') return
    await copyToClipboard(exportText(info.format, columns, rows, options))
    onClose()
  }

  const save = async (): Promise<void> => {
    setIsSaving(true)
    try {
      const data = info.format === 'xlsx'
        ? xlsxBytes(columns, rows)
        : (info.format === 'csv' || info.format === 'tsv' ? UTF8_MARK : '') + exportText(info.format, columns, rows, options)
      const saved = await window.electronAPI.saveExportFile?.(exportFileName(tableName.trim() || table, info.extension, new Date()), info.extension, data)
      if (!saved) toast.error('저장하지 못했습니다', '앱을 다시 시작해 주세요.')
      else if (saved.success) {
        toast.success('결과를 저장했습니다', saved.filePath)
        onClose()
      } else if (!saved.cancelled) toast.error('저장하지 못했습니다', saved.error)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(isOpen) => { if (!isOpen && !isSaving) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content db-export-dialog" aria-describedby="db-export-summary">
          <Dialog.Title className="modal-title">
            <RiShareForwardBoxLine size={18} aria-hidden="true" /> 결과 추출
          </Dialog.Title>
          <p id="db-export-summary" className="db-export-summary">
            {rows.length.toLocaleString()}행 · {columns.length}열
            {result.truncatedBy && <span className="db-export-cut"> · 받은 만큼만 들어갑니다 (쿼리 결과가 잘렸습니다)</span>}
          </p>

          <div className="db-export-section">
            <span className="db-export-label" id="db-export-format">형식</span>
            <div className="db-export-formats" role="radiogroup" aria-labelledby="db-export-format">
              {EXPORT_FORMATS.map(item => (
                <button
                  key={item.format}
                  type="button"
                  role="radio"
                  aria-checked={item.format === info.format}
                  className={`db-export-format${item.format === info.format ? ' is-selected' : ''}`}
                  onClick={() => change({ format: item.format as ExportFormat })}
                >
                  <span className="db-export-format-name">{item.label}</span>
                  <span className="db-export-format-ext">.{item.extension}</span>
                </button>
              ))}
            </div>
            <p className="db-export-hint">{info.hint}</p>
          </div>

          {(info.format === 'csv' || info.format === 'tsv') && (
            <div className="db-export-section">
              <label className="db-export-check">
                <input type="checkbox" checked={prefs.includeHeader} onChange={(e) => change({ includeHeader: e.target.checked })} />
                <span>첫 줄에 열 이름 넣기</span>
              </label>
            </div>
          )}
          {info.format === 'sql' && (
            <div className="db-export-section">
              <label className="db-export-label" htmlFor="db-export-table">테이블 이름</label>
              <input id="db-export-table" className="db-export-input" value={tableName} onChange={(e) => setTableName(e.target.value)} placeholder="예: public.orders" spellCheck={false} maxLength={200} />
            </div>
          )}

          <div className="db-export-section">
            <span className="db-export-label">미리보기</span>
            {preview !== null
              ? <pre className="db-export-preview">{preview || '(내용 없음)'}{rows.length > PREVIEW_ROWS ? `\n… 외 ${(rows.length - PREVIEW_ROWS).toLocaleString()}행` : ''}</pre>
              : <p className="db-export-preview is-note">시트 하나에 담습니다. 열 이름은 굵은 첫 줄로 고정되고, 숫자·참거짓은 그 형식 그대로 들어갑니다.</p>}
          </div>

          <div className="modal-actions db-export-actions">
            <button type="button" className="btn-secondary modal-btn" onClick={onClose} disabled={isSaving}>취소</button>
            <button type="button" className="btn-secondary modal-btn" onClick={() => void copy()} disabled={isSaving || info.isBinary} title={info.isBinary ? '엑셀 파일은 저장만 할 수 있습니다' : '클립보드에 복사합니다'}>
              <RiFileCopyLine size={14} aria-hidden="true" /> 복사
            </button>
            <button type="button" className="btn-primary modal-btn" onClick={() => void save()} disabled={isSaving}>
              <RiDownload2Line size={14} aria-hidden="true" /> {isSaving ? '저장 중…' : '파일로 저장…'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
