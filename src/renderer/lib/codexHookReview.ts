// The notice over a Codex pane while Codex asks to review hooks (docs/plan/2026-11-24-agent-state-via-official-signals.md
// §2.4, rules 9·10). "Trust all" also trusts hooks of other programs and repositories waiting for review,
// so it is suggested only when every new hook is one ezShell added.
import type { CodexHookReview } from '../types'

export interface CodexHookReviewNotice {
  /** Every hook waiting for review is ezShell's: "Trust all and continue" is safe to suggest */
  allOurs: boolean
  message: string
  /** Codex's screen has "Continue without trusting" picked (3 or Esc) */
  declining: boolean
}

/**
 * `projectHooks`: main saw hooks of the project among the new ones, or could not tell (codex-4's contract,
 * reviews 20·22); then the counts matching does not mean they are all ezShell's
 */
export function codexHookReviewNotice(review: CodexHookReview & { projectHooks?: boolean }): CodexHookReviewNotice {
  const allOurs = review.count > 0 && review.count === review.injectedCount && review.projectHooks !== true
  const message = allOurs
    ? `Codex 가 새 훅 ${review.count}개를 검토할지 묻고 있습니다. 모두 ezShell 의 것이라 \`2. Trust all and continue\` 를 골라도 됩니다. 승인하면 ezShell 이 Codex 의 상태를 정확히 알 수 있습니다.`
    : `Codex 가 새 훅 ${review.count}개를 검토할지 묻고 있습니다. 다른 프로그램이나 저장소의 훅이 섞여 있을 수 있으니 \`1. Review hooks\` 에서 확인해 주세요. 승인하지 않아도 지금처럼 동작합니다.`
  return { allOurs, message, declining: review.declineSelected }
}

export const DECLINING_NOTE = 'Continue without trusting 이 골라져 있습니다. 이번 실행에서는 ezShell 의 훅이 실행되지 않습니다.'
/** In the bar after `묻지 않기` (the app-wide toast says where to turn it back on) */
export const DECLINED_NOTE = '다음 실행부터 Codex 에 훅을 넣지 않습니다. 지금 화면에서는 `3. Continue without trusting` 을 고르세요.'
