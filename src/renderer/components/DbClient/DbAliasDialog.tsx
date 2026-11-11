import { useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiDatabase2Line } from 'react-icons/ri'
import { useSessionStore } from '../../stores/sessionStore'
import { ALIAS_MAX_LENGTH, withAlias, type DbGroup } from '../../lib/dbChoices'

export interface DbAliasTarget {
  savedSessionId: string
  group: DbGroup
}

interface DbAliasDialogProps {
  target: DbAliasTarget
  onClose: () => void
}

/**
 * Names one database server of a session ("MBRIS 운영 DB"). Saved with the session, so it is encrypted
 * with the session file like the DB accounts. An empty name removes the alias.
 */
export function DbAliasDialog({ target, onClose }: DbAliasDialogProps) {
  const { group } = target
  const [value, setValue] = useState(group.alias ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const updateSession = useSessionStore(state => state.updateSession)
  const saveToBackend = useSessionStore(state => state.saveToBackend)
  const session = useSessionStore(state => state.sessions.find(s => s.id === target.savedSessionId))
  // The detail without the alias: "PostgreSQL · 127.0.0.1:5432"
  const original = group.alias ? group.detail : `${group.label} · ${group.detail}`

  const save = async (next: string): Promise<void> => {
    if (!session) return
    setIsSaving(true)
    updateSession(session.id, { dbAliases: withAlias(session.dbAliases, group.key, next) })
    await saveToBackend()
    setIsSaving(false)
    onClose()
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void save(value)
  }

  return (
    <Dialog.Root open onOpenChange={(isOpen) => { if (!isOpen && !isSaving) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content db-alias-dialog" aria-describedby="db-alias-note">
          <Dialog.Title className="modal-title">
            <RiDatabase2Line size={18} aria-hidden="true" />
            DB 별칭
          </Dialog.Title>
          <p id="db-alias-note" className="db-alias-note">{original}</p>
          <form onSubmit={submit}>
            <div className="form-group">
              <label htmlFor="db-alias">별칭</label>
              <input
                id="db-alias"
                value={value}
                autoFocus
                maxLength={ALIAS_MAX_LENGTH}
                placeholder="예: MBRIS 운영 DB"
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            {!session && <p className="db-connect-error" role="alert">저장한 세션에서만 별칭을 붙일 수 있습니다.</p>}
            <div className="modal-actions db-connect-actions">
              {group.alias && (
                <button type="button" className="btn-secondary modal-btn" onClick={() => void save('')} disabled={isSaving || !session}>
                  별칭 지우기
                </button>
              )}
              <span className="db-connect-spacer" />
              <button type="button" className="btn-secondary modal-btn" onClick={onClose} disabled={isSaving}>취소</button>
              <button type="submit" className="btn-primary modal-btn" disabled={isSaving || !session}>저장</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
