const { LIMITS, clip, oneLine, text, timeOf } = require('./items.js')
const { createTurnUsage } = require('./turnUsage.js')

// Antigravity CLI's compact and full JSONL logs use the same step schema. The USER_REQUEST
// wrapper is also recognized by Orca's Antigravity session scanner (MIT).
// https://github.com/stablyai/orca/blob/main/src/main/ai-vault/session-scanner-antigravity-parser.ts
const REQUEST_OPEN = '<USER_REQUEST>'
const REQUEST_END = /<\/USER_REQUEST>(?=\s*(?:<ADDITIONAL_METADATA>|$))/
const TOOL_SUMMARY_KEYS = [
  'toolSummary', 'CommandLine', 'AbsolutePath', 'TargetFile', 'Path', 'DirectoryPath',
  'Query', 'query', 'Pattern', 'SearchPath', 'URL', 'Url', 'url', 'Description'
]

function userText(content) {
  const prompt = text(content).trim()
  if (!prompt.startsWith(REQUEST_OPEN)) return prompt
  // A truncated envelope must not expose the attached metadata as the user's words.
  const end = REQUEST_END.exec(prompt)
  return end ? prompt.slice(REQUEST_OPEN.length, end.index).trim() : ''
}

function toolCall(call) {
  const name = oneLine(text(call?.name))
  if (!name) return null
  const value = TOOL_SUMMARY_KEYS.map(key => call.args?.[key]).find(value => text(value).trim())
  // The transcript declares calls here. The separate GENERIC rows can contain arbitrary tool output
  // without a call ID. Render the invocation summary without pretending to follow its execution.
  return { name, summary: oneLine(value), input: '', result: '' }
}

const tokens = value => Number.isSafeInteger(value) && value > 0 ? value : 0

function createAntigravityParser() {
  const turns = createTurnUsage()

  function feed(line, { older = false } = {}) {
    const items = []
    const step = line?.step_index
    if (!Number.isSafeInteger(step) || step < 0) return { items }
    const time = timeOf(line.created_at)
    if (line.source === 'USER_EXPLICIT' && line.type === 'USER_INPUT') {
      const prompt = userText(line.content)
      const hasImage = Array.isArray(line.media) && line.media.some(entry => /^image\//i.test(text(entry?.mime_type)))
      if (prompt || hasImage) {
        const item = { id: `agy-user:${step}`, kind: 'user', time, text: clip(prompt, LIMITS.text), ...(hasImage ? { hasImage } : {}) }
        turns.start(item, { older })
        items.push(item)
      }
    } else if (line.source === 'MODEL' && line.type === 'PLANNER_RESPONSE') {
      const thinking = text(line.thinking)
      if (thinking.trim()) items.push({ id: `agy-thinking:${step}`, kind: 'thinking', time, text: clip(thinking, LIMITS.thinking) })
      const answer = text(line.content)
      if (answer.trim()) items.push({ id: `agy-assistant:${step}`, kind: 'assistant', time, text: clip(answer, LIMITS.text) })
      if (Array.isArray(line.tool_calls)) {
        line.tool_calls.forEach((call, index) => {
          const tool = toolCall(call)
          if (tool) items.push({ id: `tool:agy-${step}-${index}`, kind: 'tool', time, tool })
        })
      }

      const uncached = tokens(line.input_tokens)
      const cached = tokens(line.cache_read_tokens)
      const output = tokens(line.output_tokens)
      // Saved steps report uncached input and cache reads separately. Chat's input includes both.
      const input = uncached + cached
      if (input || output) {
        const owner = turns.add(step, { input, cached, output }, { older, at: time })
        if (owner) items.push(owner)
      }
    }
    return { items }
  }

  return { feed, beginOlder: turns.beginOlder, endOlder: turns.endOlder }
}

module.exports = { createAntigravityParser }
