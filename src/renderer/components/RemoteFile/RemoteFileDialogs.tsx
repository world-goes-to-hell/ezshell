import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiErrorWarningLine, RiSave3Line } from 'react-icons/ri'
import { McpDiffView } from '../Mcp/McpDiffView'
import type { McpDiffHunk } from '../../types'
import '../Mcp/Mcp.css'

export interface SaveReview {
  added: number
  removed: number
  isWholeFile: boolean
  hunks: McpDiffHunk[]
  truncated: boolean
}

interface SaveReviewDialogProps {
  review: SaveReview | null
  path: string
  isSaving: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Ctrl+S: what the save changes on the server, before anything is written. Focus starts on 취소. */
export function SaveReviewDialog({ review, path, isSaving, onConfirm, onCancel }: SaveReviewDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  // A change too long to show in full is saved only after saying so
  const [acceptsUnseen, setAcceptsUnseen] = useState(false)
  useEffect(() => { setAcceptsUnseen(false) }, [review])
  const canConfirm = !isSaving && (!review?.truncated || acceptsUnseen)
  return (
    <Dialog.Root open={review !== null} onOpenChange={(open) => { if (!open && !isSaving) onCancel() }}>
      {review && (
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay remote-file-dialog-overlay" />
          <Dialog.Content
            className="modal-content remote-file-dialog remote-file-save-dialog"
            onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus() }}
          >
            <Dialog.Title className="modal-title">
              <RiSave3Line size={20} className="remote-file-dialog-icon" aria-hidden="true" />
              서버 파일에 저장
            </Dialog.Title>
            <Dialog.Description className="remote-file-dialog-text">
              <span className="remote-file-dialog-path">{path}</span>
              <span>
                <span className="remote-file-added">+{review.added}</span> <span className="remote-file-removed">-{review.removed}</span> 줄.
                저장하기 전에 지금 서버의 내용을 PC 의 문서\ezShell Backups 폴더에 백업합니다 (평문 파일).
              </span>
              {review.isWholeFile && <span className="remote-file-dialog-note">변경 범위를 계산하지 못해 전체 교체로 표시합니다.</span>}
            </Dialog.Description>
            <McpDiffView hunks={review.hunks} />
            {review.truncated && (
              <label className="remote-file-dialog-check">
                <input type="checkbox" checked={acceptsUnseen} onChange={(event) => setAcceptsUnseen(event.target.checked)} />
                <span>변경이 많아 앞부분만 표시했습니다. 나머지를 보지 않고 저장합니다.</span>
              </label>
            )}
            <div className="modal-actions">
              <button ref={cancelRef} type="button" className="btn-secondary modal-btn" onClick={onCancel} disabled={isSaving}>취소</button>
              <button type="button" className="btn-primary modal-btn" onClick={onConfirm} disabled={!canConfirm}>
                {isSaving ? '저장하는 중…' : '백업 후 저장'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  )
}

export type ConflictChoice = 'reload' | 'compare' | 'cancel'

interface ConflictDialogProps {
  isOpen: boolean
  onChoose: (choice: ConflictChoice) => void
}

/** The server file changed after it was opened: nothing was written. */
export function ConflictDialog({ isOpen, onChoose }: ConflictDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) onChoose('cancel') }}>
      {isOpen && (
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay remote-file-dialog-overlay" />
          <Dialog.Content
            className="modal-content remote-file-dialog"
            onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus() }}
          >
            <Dialog.Title className="modal-title">
              <RiErrorWarningLine size={20} className="remote-file-dialog-icon is-warning" aria-hidden="true" />
              서버의 파일이 바뀌었습니다
            </Dialog.Title>
            <Dialog.Description className="remote-file-dialog-text">
              <span>이 창에서 연 뒤에 다른 사람이나 프로그램이 파일을 바꿔서 저장하지 않았습니다.</span>
              <span>서버의 새 내용과 다시 비교하면, 바뀐 부분을 확인한 뒤 내 내용으로 저장할 수 있습니다.</span>
            </Dialog.Description>
            <div className="modal-actions remote-file-dialog-actions">
              <button ref={cancelRef} type="button" className="btn-secondary modal-btn" onClick={() => onChoose('cancel')}>취소</button>
              <button type="button" className="btn-secondary modal-btn" onClick={() => onChoose('reload')}>서버 내용 다시 불러오기 (내 변경 버림)</button>
              <button type="button" className="btn-primary modal-btn" onClick={() => onChoose('compare')}>서버 내용과 다시 비교</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  )
}
