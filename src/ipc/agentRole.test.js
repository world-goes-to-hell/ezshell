import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { validateRole } = require('./agentRole.js')

describe('validateRole', () => {
  it('rejects an agent role that names another agent anywhere in it', () => {
    for (const role of ['PL · claude-1', 'claude-1 PL', 'codex2팀장', 'ｃｌａｕｄｅ１ 리드', '리드 antigravity-3']) {
      expect(() => validateRole(role, 'agent')).toThrow()
    }
  })

  it('keeps ordinary roles and leaves the user free to name anything', () => {
    for (const role of ['리뷰어', 'PL', 'claude 리뷰', '클로드-1']) {
      expect(validateRole(role, 'agent')).toBe(role)
    }
    expect(validateRole('PL · claude-1', 'user')).toBe('PL · claude-1')
  })
})
