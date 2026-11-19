const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const LIMITS = {
  title: 200,
  preview: 300,
  firstPrompt: 20000,
  turn: 4000,
  turns: 8
}

const isUuid = value => typeof value === 'string' && UUID.test(value)

function clip(text, max) {
  if (typeof text !== 'string') return ''
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** One line for lists: whitespace runs become a space */
const oneLine = (text, max) => clip(String(text ?? '').replace(/\s+/g, ' ').trim(), max)

const isoTime = value => {
  const time = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN
  return Number.isFinite(time) ? time : null
}

const textOrNull = value => (typeof value === 'string' && value.trim() ? value.trim() : null)

module.exports = { LIMITS, isUuid, clip, oneLine, isoTime, textOrNull }
