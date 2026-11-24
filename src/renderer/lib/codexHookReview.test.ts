import { describe, expect, it } from 'vitest'
import { codexHookReviewNotice } from './codexHookReview'

describe('codexHookReviewNotice', () => {
  it('suggests Trust all only when every new hook is ezShell’s', () => {
    const notice = codexHookReviewNotice({ count: 3, injectedCount: 3, declineSelected: false })
    expect(notice.allOurs).toBe(true)
    expect(notice.message).toContain('Trust all and continue')
    expect(notice.message).toContain('새 훅 3개')
  })

  it('points to Review hooks, without Trust all, when other hooks may be among them', () => {
    for (const review of [{ count: 4, injectedCount: 3 }, { count: 2, injectedCount: 3 }, { count: 0, injectedCount: 0 }]) {
      const notice = codexHookReviewNotice({ ...review, declineSelected: false })
      expect(notice.allOurs).toBe(false)
      expect(notice.message).toContain('Review hooks')
      expect(notice.message).not.toMatch(/Trust all|trust all/)
      expect(notice.message).toContain('다른 프로그램이나 저장소의 훅')
    }
  })

  it('does not suggest Trust all when main saw (or could not rule out) project hooks', () => {
    const notice = codexHookReviewNotice({ count: 3, injectedCount: 3, declineSelected: false, projectHooks: true })
    expect(notice.allOurs).toBe(false)
    expect(notice.message).not.toMatch(/Trust all/)
    expect(codexHookReviewNotice({ count: 3, injectedCount: 3, declineSelected: false, projectHooks: false }).allOurs).toBe(true)
  })

  it('tells when Continue without trusting is picked on the screen', () => {
    expect(codexHookReviewNotice({ count: 3, injectedCount: 3, declineSelected: true }).declining).toBe(true)
    expect(codexHookReviewNotice({ count: 3, injectedCount: 3, declineSelected: false }).declining).toBe(false)
  })
})
