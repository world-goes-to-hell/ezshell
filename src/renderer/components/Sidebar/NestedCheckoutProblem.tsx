import { useState } from 'react'
import type { NestedCheckoutMode, NestedCheckoutResult } from '../../types'

// The branch dialog's second step when Git refused to switch over local edits (IntelliJ's "Git checkout problem").
// Smart checkout stashes the edits, switches and applies them again. Force checkout switches to the target's
// version and keeps the edits as a stash backup, so it asks once more. See src/ipc/nestedCheckout.js.

function FileList({ files, label }: { files: string[]; label: string }) {
  return (
    <ul className="nested-checkout-files" aria-label={label}>
      {files.map(file => <li key={file} title={file}>{file}</li>)}
    </ul>
  )
}

export function NestedCheckoutProblem({ branch, files, busy, onChoose, onCancel }: {
  branch: string
  files: string[]
  busy: boolean
  onChoose: (mode: NestedCheckoutMode) => void
  onCancel: () => void
}) {
  const [confirmForce, setConfirmForce] = useState(false)
  if (confirmForce) {
    return (
      <div className="nested-checkout-problem" data-step="force">
        <p className="nested-checkout-text">
          수정한 내용을 모두 치우고 <strong>{branch}</strong> 브랜치의 내용으로 바꿉니다.
          치운 변경은 stash 에 백업해 두므로 나중에 되돌릴 수 있습니다. 추적하지 않는 파일은 그대로 남습니다.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn-secondary modal-btn" disabled={busy} onClick={() => setConfirmForce(false)}>돌아가기</button>
          <button type="button" className="btn-danger modal-btn" disabled={busy} onClick={() => onChoose('force')}>
            {busy ? '바꾸는 중…' : '치우고 바꾸기'}
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="nested-checkout-problem" data-step="choose">
      <p className="nested-checkout-text">
        다음 파일의 변경이 <strong>{branch}</strong> 브랜치로 바꾸면 덮어써질 수 있습니다.
        스마트 체크아웃은 변경을 잠시 보관하고 브랜치를 바꾼 뒤 다시 적용합니다.
      </p>
      <FileList files={files} label="덮어써질 수 있는 파일" />
      <div className="modal-actions nested-checkout-actions">
        <button type="button" className="btn-secondary modal-btn nested-checkout-force" disabled={busy}
          onClick={() => setConfirmForce(true)}>강제 체크아웃</button>
        <button type="button" className="btn-primary modal-btn" disabled={busy} onClick={() => onChoose('smart')}>
          {busy ? '바꾸는 중…' : '스마트 체크아웃'}
        </button>
        <button type="button" className="btn-secondary modal-btn" disabled={busy} onClick={onCancel}>체크아웃 안 함</button>
      </div>
    </div>
  )
}

/** What the user should know after a checkout with edits: conflicts left to resolve, or where the backup is */
export function NestedCheckoutNotice({ branch, result, onClose }: { branch: string; result: NestedCheckoutResult; onClose: () => void }) {
  return (
    <div className="nested-checkout-problem" data-step="done" role="status">
      {result.kind === 'smart' ? <>
        <p className="nested-checkout-text">
          <strong>{branch}</strong> 브랜치로 바꿨지만, 변경을 다시 적용하다 다음 파일에서 충돌이 났습니다.
          파일의 충돌 표시를 정리해 주세요. 원래 변경은 stash <strong>{result.stash}</strong> 에 남아 있습니다.
        </p>
        <FileList files={result.conflicts} label="충돌이 난 파일" />
      </> : (
        <p className="nested-checkout-text">
          <strong>{branch}</strong> 브랜치로 바꿨습니다. 치운 변경은 stash <strong>{result.stash}</strong> 에 백업했습니다.
          필요하면 <code>git stash list</code> 로 찾아 다시 적용할 수 있습니다.
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn-primary modal-btn" onClick={onClose}>닫기</button>
      </div>
    </div>
  )
}
