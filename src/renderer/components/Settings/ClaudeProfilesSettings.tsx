import { useEffect, useState, type FormEvent } from 'react'
import { openClaudeProfile, useClaudeProfiles } from '../../lib/claudeProfiles'
import type { ClaudeProfile } from '../../types'

export function ClaudeProfilesSettings({ onOpen }: { onOpen: () => void }) {
  const { profiles, load, save } = useClaudeProfiles()
  const [editing, setEditing] = useState<ClaudeProfile | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { void load().catch(() => setError('Claude 계정 목록을 불러올 수 없습니다.')) }, [load])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const failure = await save({ id: editing?.id, name })
      if (failure) setError(failure)
      else { setEditing(null); setName('') }
    } catch { setError('Claude 계정을 저장할 수 없습니다.') }
    finally { setBusy(false) }
  }

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">Claude Code 계정</h3>
      <p className="settings-section-desc">개인과 업무 계정을 따로 열 수 있습니다. 새 계정을 처음 열면 Claude Code에서 로그인합니다.</p>
      <ul className="claude-profile-list">
        {profiles.map(profile => <li key={profile.id}>
          <span>{profile.name}</span>
          {profile.id !== 'default' && <button type="button" className="btn-secondary" disabled={busy}
            onClick={() => { setEditing(profile); setName(profile.name); setError('') }}>이름 변경</button>}
          <button type="button" className="btn-secondary" disabled={busy} aria-label={`${profile.name} 열기`}
            onClick={() => { onOpen(); openClaudeProfile({ profileId: profile.id }) }}>열기</button>
        </li>)}
      </ul>
      <form onSubmit={submit}>
        <div className="form-group">
          <label htmlFor="claude-profile-name">{editing ? '새 계정 이름' : '추가할 계정 이름'}</label>
          <div className="claude-profile-form">
            <input id="claude-profile-name" value={name} maxLength={40} placeholder="예) 업무" disabled={busy}
              onChange={event => setName(event.target.value)} />
            <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>{editing ? '저장' : '계정 추가'}</button>
            {editing && <button type="button" className="btn-secondary" disabled={busy}
              onClick={() => { setEditing(null); setName(''); setError('') }}>취소</button>}
          </div>
          {error && <p role="alert">{error}</p>}
        </div>
      </form>
    </section>
  )
}
