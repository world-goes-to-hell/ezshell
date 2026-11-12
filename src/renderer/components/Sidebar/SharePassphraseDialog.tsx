import { useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiKey2Line, RiLoader4Line } from 'react-icons/ri'
import { PASSPHRASE_MAX, PASSPHRASE_MIN, generatePassphrase } from '../../lib/shareCrypto'
import './SessionImportDialog.css'

interface SharePassphraseDialogProps {
  /** What is being copied, e.g. `"[운영] WAS" 세션` or `"운영" 폴더 안 모든 세션` */
  subject: string
  onCancel: () => void
  /** Builds and copies the text; the dialog closes when it resolves */
  onConfirm: (passphrase: string) => Promise<void>
}

function problemOf(passphrase: string, again: string): string | null {
  if (passphrase.length < PASSPHRASE_MIN) return `공유 암호는 ${PASSPHRASE_MIN}자 이상이어야 합니다.`
  if (passphrase.length > PASSPHRASE_MAX) return `공유 암호는 ${PASSPHRASE_MAX}자까지입니다.`
  if (passphrase !== again) return '두 번 입력한 공유 암호가 다릅니다.'
  return null
}

/**
 * "비밀번호 포함 복사…": the passwords are sealed with a passphrase the user picks here and tells the
 * other person another way. The passphrase is not kept anywhere.
 */
export function SharePassphraseDialog({ subject, onCancel, onConfirm }: SharePassphraseDialogProps) {
  const [passphrase, setPassphrase] = useState('')
  const [again, setAgain] = useState('')
  const [isTouched, setIsTouched] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  // A generated passphrase is shown in plain text so it can be read out over the phone
  const [generated, setGenerated] = useState<string | null>(null)
  const problem = problemOf(passphrase, again)

  const generate = (): void => {
    const value = generatePassphrase()
    setGenerated(value)
    setPassphrase(value)
    setAgain(value)
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setIsTouched(true)
    if (problem) return
    setIsBusy(true)
    try {
      await onConfirm(passphrase)
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(isOpen) => { if (!isOpen && !isBusy) onCancel() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content share-passphrase-dialog" aria-describedby="share-passphrase-note">
          <Dialog.Title className="modal-title">
            <RiKey2Line size={18} aria-hidden="true" />
            비밀번호 포함 복사
          </Dialog.Title>
          <div id="share-passphrase-note" className="share-passphrase-note">
            <p>{subject}의 접속 비밀번호를 <strong>공유 암호</strong>로 암호화해서 복사합니다.</p>
            <p>받는 사람은 이 공유 암호를 알아야 비밀번호를 풀 수 있습니다. 공유 암호는 텍스트를 보낸 메신저가 아닌 <strong>전화나 직접 만나서</strong> 알려 주세요. 같은 곳에 보내면 암호화한 의미가 없습니다.</p>
          </div>
          <form onSubmit={(e) => void submit(e)}>
            <div className="form-group">
              <div className="share-passphrase-label-row">
                <label htmlFor="share-passphrase">공유 암호 ({PASSPHRASE_MIN}자 이상)</label>
                <button type="button" className="share-passphrase-generate" onClick={generate} disabled={isBusy}>무작위로 만들기</button>
              </div>
              <input
                id="share-passphrase"
                type="password"
                value={passphrase}
                autoFocus
                maxLength={PASSPHRASE_MAX}
                onChange={(e) => { setPassphrase(e.target.value); setGenerated(null) }}
                autoComplete="new-password"
              />
            </div>
            {generated && generated === passphrase && (
              <p className="share-passphrase-generated">만든 공유 암호: <code>{generated}</code> (받는 사람에게 전화 등으로 불러 주세요)</p>
            )}
            <div className="form-group">
              <label htmlFor="share-passphrase-again">공유 암호 확인</label>
              <input
                id="share-passphrase-again"
                type="password"
                value={again}
                maxLength={PASSPHRASE_MAX}
                onChange={(e) => { setAgain(e.target.value); setGenerated(null) }}
                onBlur={() => setIsTouched(true)}
                autoComplete="new-password"
              />
            </div>
            {isTouched && problem && <p className="session-import-error" role="alert">{problem}</p>}
            <div className="modal-actions">
              <button type="button" className="btn-secondary modal-btn" onClick={onCancel} disabled={isBusy}>취소</button>
              <button type="submit" className="btn-primary modal-btn" disabled={isBusy}>
                {isBusy && <RiLoader4Line className="spinning" size={14} aria-hidden="true" />} 암호화해서 복사
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
