import { useEffect, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useToastStore } from '../../stores/toastStore'
import { CopiedTextAgentDialog } from './CopiedTextAgentDialog'
import { Toast } from './Toast'
import './Toast.css'

export function ToastContainer({ allowAgentSend = false }: { allowAgentSend?: boolean }) {
  const { toasts, position } = useToastStore()
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null)

  // The main window unmounts this host when it locks. Drop pending copies along with the draft.
  useEffect(() => {
    if (!allowAgentSend) return
    return () => useToastStore.setState(state => ({ toasts: state.toasts.filter(toast => toast.copiedText === undefined) }))
  }, [allowAgentSend])

  return (
    <>
      <div className={`toast-container toast-${position}`} aria-live="polite" aria-atomic="false">
        <AnimatePresence mode="popLayout">
          {toasts.map(toast => {
            const text = toast.copiedText
            const action = allowAgentSend && text !== undefined
              ? { label: '에이전트에 보내기', run: () => setDraft({ id: toast.id, text }) }
              : toast.action
            return <Toast key={toast.id} toast={toast} action={action} />
          })}
        </AnimatePresence>
      </div>
      {draft && <CopiedTextAgentDialog key={draft.id} copiedText={draft.text} onClose={() => setDraft(null)} />}
    </>
  )
}
