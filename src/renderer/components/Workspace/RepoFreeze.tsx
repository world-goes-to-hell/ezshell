// Freezing a repository from the "변경" tab (docs/plan/2026-11-28-agent-file-owners.md, 알리기): nothing is blocked;
// main sends the other agents of the repository an urgent message to stop, `except` keeps working, and thawing sends
// them a plain one. While frozen a band says so, with 해제 (no question: thawing only sends the message).
import { useState, type FormEvent } from 'react'
import { RiSnowflakeLine } from 'react-icons/ri'
import { agentsInRepo, FREEZE_REASON_MAX, freezeLine, freezeReason } from '../../lib/fileOwners'
import { useAgentMessagesStore } from '../Terminal/AgentMessages'
import { toast } from '../../stores/toastStore'
import type { WorkspaceFreeze } from '../../types'

export function RepoFreeze({ top, freeze, onChanged }: {
  /** The repository (repo.top, as the commit takes) */
  top: string
  freeze: WorkspaceFreeze | null
  onChanged: () => void
}) {
  const agents = useAgentMessagesStore(state => state.snapshot.agents)
  const [open, setOpen] = useState(false)
  const [except, setExcept] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const freezeApi = window.electronAPI.workspaceFileFreeze
  if (typeof freezeApi !== 'function') return null
  const inRepo = agentsInRepo(agents, top)

  const change = async (frozen: boolean, options: { except?: string; reason?: string } = {}) => {
    setBusy(true)
    try {
      const result = await freezeApi(top, frozen, options.except, options.reason)
      if (!result?.success) { setError(result?.error ?? '바꾸지 못했습니다.'); return false }
      toast.success(frozen ? '저장소를 동결했습니다' : '동결을 풀었습니다', frozen ? '다른 에이전트에게 멈추라고 알렸습니다.' : '에이전트들에게 다시 일해도 된다고 알렸습니다.')
      onChanged()
      return true
    } catch {
      setError('바꾸지 못했습니다.')
      return false
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const checked = freezeReason(reason)
    if ('error' in checked) { setError(checked.error); return }
    setError(null)
    if (await change(true, { except: except || undefined, reason: checked.reason })) {
      setOpen(false)
      setReason('')
    }
  }

  if (freeze) {
    return (
      <div className="workspace-freeze-band" role="status">
        <RiSnowflakeLine size={14} aria-hidden="true" />
        <span className="workspace-freeze-line">{freezeLine(freeze)}</span>
        <button type="button" className="workspace-freeze-thaw" disabled={busy} onClick={() => void change(false)}>해제</button>
      </div>
    )
  }
  if (!open) {
    return (
      <button type="button" className="workspace-freeze-open" onClick={() => { setError(null); setOpen(true) }}
        title="병합 등으로 이 저장소를 잠시 혼자 쓸 때: 다른 에이전트에게 멈추라고 알립니다 (막지는 않습니다)">
        <RiSnowflakeLine size={13} aria-hidden="true" /> 동결
      </button>
    )
  }
  return (
    <form className="workspace-freeze-form" onSubmit={submit} aria-label="저장소 동결">
      <p className="workspace-freeze-note">이 저장소에서 일하는 다른 에이전트에게 긴급 메시지로 멈추라고 알립니다. 편집을 막지는 않습니다.</p>
      <label className="workspace-freeze-field">
        <span>계속 작업할 에이전트</span>
        <select value={except} onChange={event => setExcept(event.target.value)} disabled={busy}>
          <option value="">없음 (모두 멈춤)</option>
          {inRepo.map(agent => <option key={agent.id} value={agent.id}>{agent.role ? `${agent.id} · ${agent.role}` : agent.id}</option>)}
        </select>
      </label>
      <label className="workspace-freeze-field">
        <span>이유</span>
        <input value={reason} maxLength={FREEZE_REASON_MAX} placeholder="예: origin/main 병합 중" disabled={busy}
          onChange={event => setReason(event.target.value)} spellCheck={false} autoComplete="off" />
      </label>
      {error && <p className="workspace-freeze-error" role="alert">{error}</p>}
      <div className="workspace-freeze-actions">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => setOpen(false)}>취소</button>
        <button type="submit" className="btn-primary" disabled={busy}>동결하고 알리기</button>
      </div>
    </form>
  )
}
