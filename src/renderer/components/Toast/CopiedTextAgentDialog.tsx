import { useId, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { RiSendPlaneLine } from 'react-icons/ri'
import { agentIdentityLabel } from '../../lib/agentIdentity'
import { toast } from '../../stores/toastStore'
import { useAgentMessagesStore } from '../Terminal/AgentMessages'

const MAX_MESSAGE_LENGTH = 8000

export function CopiedTextAgentDialog({ copiedText, onClose }: { copiedText: string; onClose: () => void }) {
  const allAgents = useAgentMessagesStore(state => state.snapshot.agents)
  const agents = allAgents.filter(agent => agent.active && (agent.mcpConnected || agent.status === 'sleeping'))
  const [agentId, setAgentId] = useState('')
  const [text, setText] = useState(copiedText)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const recipientId = useId()
  const textId = useId()
  const statusId = useId()
  const recipient = agents.find(agent => agent.id === agentId)
  const tooLong = text.length > MAX_MESSAGE_LENGTH

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!recipient || !text.trim() || tooLong || sending) return

    setSending(true)
    setError('')
    try {
      const result = await window.electronAPI.agentMessageSendCopiedText(recipient.id, text)
      if (result.success) {
        toast.success('에이전트에 보냈습니다', agentIdentityLabel(recipient))
        onClose()
      } else {
        setError(result.error)
      }
    } catch {
      setError('에이전트에 보내지 못했습니다.')
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !sending) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content copied-text-agent-dialog" aria-describedby={undefined}>
          <Dialog.Title className="modal-title"><RiSendPlaneLine aria-hidden />복사한 내용 보내기</Dialog.Title>
          <form onSubmit={send}>
            <div className="form-group">
              <label htmlFor={recipientId}>받을 에이전트</label>
              <select id={recipientId} value={recipient?.id ?? ''} disabled={sending || !agents.length}
                onChange={event => { setAgentId(event.target.value); setError('') }}>
                <option value="" disabled>{agents.length ? '에이전트 선택' : '받을 수 있는 에이전트가 없습니다'}</option>
                {agents.map(agent => <option key={agent.id} value={agent.id}>
                  {[agentIdentityLabel(agent), agent.cwd].filter(Boolean).join(' · ')}
                </option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor={textId}>보낼 내용</label>
              <textarea id={textId} value={text} rows={8} readOnly={sending} spellCheck={false}
                aria-describedby={tooLong ? statusId : undefined} aria-invalid={tooLong || undefined}
                onChange={event => { setText(event.target.value); setError('') }} />
              {tooLong && <p id={statusId} role="status">보낼 내용을 8,000자 이하로 줄여 주세요.</p>}
            </div>
            {error && <p className="copied-text-agent-error" role="alert">{error}</p>}
            <div className="modal-actions">
              <Dialog.Close className="modal-btn btn-secondary" disabled={sending}>취소</Dialog.Close>
              <button type="submit" className="modal-btn btn-primary" disabled={!recipient || !text.trim() || tooLong || sending}>
                {sending ? '보내는 중…' : '보내기'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
