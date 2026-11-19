import { useEffect, useState } from 'react'
import { toast } from '../stores/toastStore'
import { confirmDialog } from '../stores/confirmStore'
import { RESUME_AGENT_SESSION_EVENT } from '../lib/agentHistory'
import { agentDropAt, draggedAgentSession, endAgentSessionDrag, replaceAgentPane, resumeIntoPane, type AgentDropHover } from '../lib/agentSessionDrop'

const BLOCKED_TITLE = '여기서는 이어서 열 수 없습니다'

const sameHover = (a: AgentDropHover | null, b: AgentDropHover | null): boolean =>
  a === b || (!!a && !!b && a.targetId === b.targetId && a.onTab === b.onTab && a.place?.pane === b.place?.pane
    && a.place?.side === b.place?.side && a.replacement?.shellId === b.replacement?.shellId
    && a.blocked === b.blocked && a.box.left === b.box.left && a.box.top === b.box.top
    && a.box.width === b.box.width && a.box.height === b.box.height)

/**
 * A past agent session dragged from the agent history panel (lib/agentSessionDrop.ts). Listens on the
 * document in the capture phase like the tab merge (the terminals swallow drag events, and the tab
 * strips and the terminal area have drop handling of their own), and only while such a drag is on.
 * Returns where a drop would go, for the marker.
 */
export function useAgentSessionDrop(): AgentDropHover | null {
  const [hover, setHover] = useState<AgentDropHover | null>(null)

  useEffect(() => {
    let current: AgentDropHover | null = null
    const show = (next: AgentDropHover | null) => {
      if (sameHover(current, next)) return
      current = next
      setHover(next)
    }
    const onDragOver = (event: DragEvent) => {
      if (!draggedAgentSession()) return
      const next = agentDropAt(event.clientX, event.clientY)
      show(next)
      if (!next) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = next.blocked ? 'none' : 'copy'
    }
    const onDrop = (event: DragEvent) => {
      const request = draggedAgentSession()
      const target = request ? agentDropAt(event.clientX, event.clientY) : null
      show(null)
      if (!request || !target) return
      event.preventDefault()
      event.stopPropagation()
      endAgentSessionDrag()
      if (target.blocked) {
        toast.warning(BLOCKED_TITLE, target.blocked)
        return
      }
      if (!target.targetId) {
        window.dispatchEvent(new CustomEvent(RESUME_AGENT_SESSION_EVENT, { detail: request }))
        return
      }
      const { targetId, replacement } = target
      const resume = async () => {
        if (!replacement) return resumeIntoPane(request, targetId, target.place)
        const confirmed = await confirmDialog({
          title: '이 칸에서 대화를 이어서 열까요?',
          message: '기존 셸과 이 칸에서 실행 중인 작업이 종료됩니다.',
          confirmLabel: '셸 바꾸기',
          danger: true
        })
        return confirmed ? replaceAgentPane(request, targetId, replacement) : null
      }
      void resume()
        .then(result => {
          // The work panel sits beside the terminals, so the new pane is already in view
          if (result && !result.ok) toast.warning('대화를 이어서 열지 못했습니다', result.error)
        })
        .catch(() => toast.error('대화를 이어서 열지 못했습니다', '잠시 후 다시 시도해 주세요.'))
    }
    const onDragEnd = () => {
      endAgentSessionDrag()
      show(null)
    }
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('drop', onDrop, true)
    document.addEventListener('dragend', onDragEnd, true)
    return () => {
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('drop', onDrop, true)
      document.removeEventListener('dragend', onDragEnd, true)
    }
  }, [])

  return hover
}
