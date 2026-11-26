const { randomUUID } = require('node:crypto')
const { cleanLogLine } = require('./developmentErrors.js')
const { suggestedMavenFields } = require('./runSuggestions.js')
const { mcpJarSuggestion, proposedJarId, selectedJarReferences, tomcatInvocation } = require('./runJarSuggestions.js')

const MAX_PROPOSALS = 5
const STALE_PROPOSAL = '이 실행에서 제안할 수 있는 최신 진단을 다시 확인해 주세요.'

async function prepareProposal({ by, request, preset, run, suggestions, candidates, projectRoot, home, now }) {
  if (typeof request.note !== 'string' || request.note.length > 1000) throw new Error('제안 메모를 1~1000자로 입력해 주세요.')
  const note = request.note.split(/\r\n|\r|\n/).map(cleanLogLine).join('\n').trim()
  if (!note) throw new Error('제안 메모를 1~1000자로 입력해 주세요.')
  const current = suggestions.find(item => item.id === request.suggestion)
  if (!current) throw new Error(STALE_PROPOSAL)
  const { proposalKind: apply } = mcpJarSuggestion(current, candidates, preset, run)
  if (!apply) throw new Error(STALE_PROPOSAL)
  const { id, repositoryId, className } = current
  const suggestion = { id, apply, ...(repositoryId && { repositoryId }), ...(className && { className }) }
  if (apply === 'tomcatJar') {
    if (request.url !== undefined) throw new Error('JAR 제안에는 후보 하나만 선택해 주세요.')
    const jarId = proposedJarId(current, candidates, preset, request.jar)
    await selectedJarReferences({ preset, run, suggestions, request: { id, jarId }, candidates, projectRoot, home })
    suggestion.jarId = jarId
  } else {
    if (request.jar !== undefined || (request.url !== undefined && (typeof request.url !== 'string' || request.url.length > 2048))) {
      throw new Error('Maven 진단에 맞는 저장소 주소를 확인해 주세요.')
    }
    const fields = suggestedMavenFields(preset, run, { id, replacementUrl: request.url })
    if (apply === 'mavenMirror') suggestion.replacementUrl = fields.mavenMirrors.find(item => item.repositoryId === repositoryId).url
  }
  return { id: randomUUID(), by, suggestion, note, at: now(), status: 'pending' }
}

function proposalStillCurrent(proposal, preset, run, suggestions) {
  const { id, apply } = proposal.suggestion
  const current = suggestions.find(item => item.id === id)
  return apply === 'tomcatJar'
    ? current?.kind === 'missingClass' && run.jarDiagnosis?.major >= 7 && run.jarDiagnosis.invocation === tomcatInvocation(preset)
    : current?.apply === apply
}

function approvedProposalStatus(proposal, request, next) {
  const { id, apply, jarId, repositoryId, replacementUrl } = proposal.suggestion
  if (request.id !== id) return 'pending'
  const accepted = apply === 'tomcatJar' ? jarId === request.jarId
    : apply === 'mavenMirror' ? next.mavenMirrors?.some(mirror => mirror.repositoryId === repositoryId && mirror.url === replacementUrl)
      : next.mavenUserSettings === false
  return accepted ? 'applied' : 'dismissed'
}

const pendingProposals = proposals => proposals.filter(item => item.status === 'pending').map(({ status: _status, ...item }) => item)

function agentProposals(proposals, by) {
  return (proposals ?? []).filter(item => item.by === by).map(({ id, note, at, status, suggestion }) => ({
    id, note, at, status, suggestion: suggestion.id, proposalKind: suggestion.apply
  }))
}

module.exports = { MAX_PROPOSALS, STALE_PROPOSAL, prepareProposal, proposalStillCurrent, approvedProposalStatus, pendingProposals, agentProposals }
