import { useState } from 'react'
import { RiFileFill, RiFileTransferFill, RiFileCopyFill, RiCloseFill, RiFileSearchFill } from 'react-icons/ri'

export type OverwriteAction = 'overwrite' | 'skip' | 'rename' | 'size-diff'

interface OverwriteModalProps {
  open: boolean
  fileName: string
  onClose: () => void
  onConfirm: (action: OverwriteAction, applyToAll: boolean) => void
}

export function OverwriteModal({ open, fileName, onClose, onConfirm }: OverwriteModalProps) {
  const [selectedAction, setSelectedAction] = useState<OverwriteAction>('overwrite')
  const [applyToAll, setApplyToAll] = useState(false)

  if (!open) return null

  const handleConfirm = () => {
    onConfirm(selectedAction, applyToAll)
    setApplyToAll(false)
  }

  return (
    <>
      <div className="modal-overlay" onClick={onClose} />
      <div className="modal-content overwrite-modal">
        <button className="modal-close-btn" onClick={onClose}>
          <RiCloseFill size={20} />
        </button>

        <h3 className="modal-title">파일이 이미 존재합니다</h3>

        <div className="modal-body">
          <div className="file-info">
            <RiFileFill size={24} className="file-icon" />
            <span className="file-name">{fileName}</span>
          </div>

          <div className="overwrite-options">
            <div
              className={`overwrite-option ${selectedAction === 'overwrite' ? 'selected' : ''}`}
              onClick={() => setSelectedAction('overwrite')}
            >
              <div className="option-icon">
                <RiFileTransferFill size={20} />
              </div>
              <div className="option-text">
                <div className="option-title">덮어쓰기</div>
                <div className="option-desc">기존 파일을 새 파일로 교체합니다</div>
              </div>
            </div>

            <div
              className={`overwrite-option ${selectedAction === 'skip' ? 'selected' : ''}`}
              onClick={() => setSelectedAction('skip')}
            >
              <div className="option-icon">
                <RiCloseFill size={20} />
              </div>
              <div className="option-text">
                <div className="option-title">건너뛰기</div>
                <div className="option-desc">이 파일을 전송하지 않습니다</div>
              </div>
            </div>

            <div
              className={`overwrite-option ${selectedAction === 'rename' ? 'selected' : ''}`}
              onClick={() => setSelectedAction('rename')}
            >
              <div className="option-icon">
                <RiFileCopyFill size={20} />
              </div>
              <div className="option-text">
                <div className="option-title">이름 바꾸기</div>
                <div className="option-desc">새 파일에 다른 이름을 지정합니다</div>
              </div>
            </div>

            <div
              className={`overwrite-option ${selectedAction === 'size-diff' ? 'selected' : ''}`}
              onClick={() => setSelectedAction('size-diff')}
            >
              <div className="option-icon">
                <RiFileSearchFill size={20} />
              </div>
              <div className="option-text">
                <div className="option-title">크기 다른 것만</div>
                <div className="option-desc">파일 크기가 다를 때만 전송, 같으면 건너뜁니다</div>
              </div>
            </div>
          </div>

          <label className="apply-all">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
            />
            <span>이후 충돌에도 동일하게 적용</span>
          </label>
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            취소
          </button>
          <button className="btn-primary" onClick={handleConfirm}>
            확인
          </button>
        </div>
      </div>
    </>
  )
}
