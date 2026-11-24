// Over a Codex pane while Codex shows its "Hooks need review" screen for the hooks ezShell added
// (docs/plan/2026-11-24-agent-state-via-official-signals.md §2.4): what to pick there, and the choice not
// to be asked again. The screen takes keys in the terminal, so in the chat view the bar offers to go there.
import { useEffect, useState } from 'react'
import { RiCloseLine, RiShieldKeyholeLine, RiTerminalBoxLine } from 'react-icons/ri'
import type { CodexHookReview } from '../../types'
import { codexHookReviewNotice, DECLINED_NOTE, DECLINING_NOTE } from '../../lib/codexHookReview'
import { toast } from '../../stores/toastStore'
import './CodexHookReviewBar.css'

export function CodexHookReviewBar({ shellId, isChat, onShowTerminal }: { shellId: string; isChat: boolean; onShowTerminal: () => void }) {
  const [review, setReview] = useState<CodexHookReview | null>(null)
  // `다음에`: hidden until this screen closes (the next run asks again); `묻지 않기` done: its note stays
  const [dismissed, setDismissed] = useState(false)
  const [declined, setDeclined] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    const show = (next: CodexHookReview | null) => {
      if (!active) return
      setReview(next)
      if (!next) {
        setDismissed(false)
        setDeclined(false)
      }
    }
    void window.electronAPI.localShellCodexHookReview?.(shellId).then(show, () => {})
    const stop = window.electronAPI.onLocalShellCodexHookReview?.(({ id, review: next }) => { if (id === shellId) show(next) })
    return () => {
      active = false
      stop?.()
    }
  }, [shellId])

  if (!review || dismissed) return null
  const notice = codexHookReviewNotice(review)

  const decline = async () => {
    const run = window.electronAPI.localShellDeclineCodexHooks
    if (busy || !run) return
    setBusy(true)
    try {
      if (await run(shellId)) setDeclined(true)
      else toast.error('설정을 바꾸지 못했습니다', '잠시 후 다시 시도해 주세요.')
    } catch {
      toast.error('설정을 바꾸지 못했습니다', '잠시 후 다시 시도해 주세요.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="codex-hook-review" role="region" aria-label="Codex 훅 승인 안내" onMouseDown={event => event.preventDefault()}>
      <RiShieldKeyholeLine className="codex-hook-review-icon" aria-hidden />
      <div className="codex-hook-review-text">
        <p>{declined ? DECLINED_NOTE : notice.message}</p>
        {notice.declining && !declined && <p className="codex-hook-review-note">{DECLINING_NOTE}</p>}
      </div>
      <div className="codex-hook-review-actions">
        {isChat && (
          <button type="button" onClick={onShowTerminal} title="이 화면은 터미널에서 답합니다">
            <RiTerminalBoxLine aria-hidden /> 터미널에서 답하기
          </button>
        )}
        {!declined && (
          <button type="button" onClick={() => void decline()} disabled={busy}
            title="다음 실행부터 Codex 에 ezShell 의 훅을 넣지 않습니다 (설정에서 다시 켤 수 있음)">
            묻지 않기
          </button>
        )}
        <button type="button" className="codex-hook-review-close" onClick={() => setDismissed(true)}
          aria-label="다음에" title="다음에 (다음 실행 때 다시 안내)">
          <RiCloseLine aria-hidden /> 다음에
        </button>
      </div>
    </div>
  )
}
