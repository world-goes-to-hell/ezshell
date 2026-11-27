const { isUuid } = require('../agentHistory/common.js')
const { copyClaudeTranscript } = require('./claudeTranscriptCopy.js')

const DEFAULT_PROFILE = 'default'
const LOCAL_SHELL = /^local:\d+$/

/**
 * Continues a pane's Claude conversation under another account: the conversation is copied to that
 * account's config folder, then a shell resuming it replaces the pane's shell (the window swaps them).
 * The session comes from what main verified for the shell, never from the window.
 */
function createClaudeAccountSwitch({ shells, profileRoot, defaultRoot, copy = copyClaudeTranscript }) {
  function rootOf(profileId) {
    if (profileId === DEFAULT_PROFILE) return defaultRoot
    const root = isUuid(profileId) ? profileRoot(profileId, true) : undefined
    if (!root) throw new Error('Claude 계정을 찾지 못했습니다.')
    return root
  }

  function switchInPlace({ shellId, profileId } = {}) {
    if (typeof shellId !== 'string' || !LOCAL_SHELL.test(shellId)) throw new Error('셸을 찾지 못했습니다.')
    if (typeof profileId !== 'string') throw new Error('Claude 계정을 찾지 못했습니다.')
    const local = shells()
    const agent = local?.agentOf(shellId)
    if (agent?.kind !== 'claude') throw new Error('Claude 세션에서만 계정을 바꿀 수 있습니다.')
    if (agent.status !== 'idle') throw new Error('Claude가 작업을 마친 뒤 다시 시도해 주세요.')
    if (!isUuid(agent.sessionId) || typeof agent.cwd !== 'string' || !agent.cwd) {
      throw new Error('이 대화를 아직 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.')
    }
    const current = local.claudeProfileOf(shellId) ?? DEFAULT_PROFILE
    if (current === profileId) throw new Error('이미 이 계정으로 실행 중입니다.')
    const targetRoot = rootOf(profileId)
    const sourceRoot = local.claudeRootOf(shellId) ?? defaultRoot
    copy({ sourceRoot, targetRoot, sessionId: agent.sessionId, cwd: agent.cwd })
    return local.open({
      agent: 'claude', cwd: agent.cwd, claudeProfileId: profileId, resume: agent.sessionId, replacementFor: shellId, cols: 80, rows: 24
    })
  }

  return { switchInPlace }
}

module.exports = { createClaudeAccountSwitch }
