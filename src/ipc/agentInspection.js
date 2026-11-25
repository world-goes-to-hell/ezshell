const HUMAN_BLOCK_LABELS = Object.freeze({
  approval: '확인 요청',
  question: '선택지 질문',
  'folder-trust': '폴더 신뢰 확인',
  'hook-trust': '훅 신뢰 확인'
})
const MAX_LINE = 200
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/u

function shortLine(text) {
  if (typeof text !== 'string') return null
  const line = text.split(LINE_BREAK, 1)[0].replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').trim()
  return Array.from(line).slice(0, MAX_LINE).join('') || null
}

function publicBlock(block) {
  switch (block?.kind) {
    case 'approval':
      return { kind: block.kind, question: shortLine(block.question), options: block.options.slice(0, 9).map(shortLine).filter(Boolean) }
    case 'question': return { kind: block.kind, question: shortLine(block.question) }
    case 'draft': return { kind: block.kind, ours: block.ours === true }
    case 'folder-trust':
    case 'hook-trust':
    case 'cli-screen':
    case 'hook-running':
    case 'ended': return { kind: block.kind }
    default: return null
  }
}

const validEscalationReason = reason => typeof reason === 'string' && Boolean(reason.trim())
  && !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(reason) && Array.from(reason).length <= MAX_LINE

module.exports = { HUMAN_BLOCK_LABELS, publicBlock, validEscalationReason }
