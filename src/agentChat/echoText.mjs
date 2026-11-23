const LEGACY_IMAGE_PROMPT = '첨부 이미지를 열어 확인해 주세요.'
const NATIVE_IMAGE_PREFIX = /^(?:\[Image #[1-9]\d*\]\s*)+/
const STORED_IMAGE_PATH = /(?:^|[/\\])ezshell-clipboard-[\w-]+[/\\][a-f0-9-]{36}\.png$/i
const CLAUDE_PASTE = /<pasted_content(?:\s[^>]*)?>([\s\S]*?)<\/pasted_content(?:\s[^>]*)?>/g
const PASTE_MARKS = /[\u0300-\u036f\u200d\ufe0e\ufe0f\u20e3\p{Emoji_Modifier}]/gu
const PASTE_SPACE = /\s/gu

const exactEchoText = (recorded, sent) => recorded === sent

function normalizedEchoText(message, sent) {
  const normalized = text => text.normalize().replace(PASTE_SPACE, '')
  if (message.trim() === sent || (message.trim() && normalized(message) === normalized(sent))) return true

  const displayed = normalized(message.replace(PASTE_MARKS, ''))
  if (!displayed) return false
  const original = normalized(sent.replace(PASTE_MARKS, ''))
  let start = 0
  for (const char of original) {
    if (displayed.startsWith(char, start)) start += char.length
    // Real Codex on Windows can drop both of these glyphs from pasted input.
    else if (char !== '✅' && char !== '❤') return false
  }
  return start === displayed.length
}

export function matchesEchoText(item, sent, relaxed) {
  const recorded = item.text?.replace(/\r\n?/g, '\n').trim() ?? ''
  const message = relaxed ? recorded.replace(CLAUDE_PASTE, '$1').trim() : recorded
  const sameText = relaxed ? normalizedEchoText : exactEchoText
  if (!sent.hasImage) return !item.hasImage && sameText(message, sent.text)
  if (item.hasImage && sameText(message, sent.text)) return true

  const tokens = NATIVE_IMAGE_PREFIX.exec(message)?.[0]
  const text = tokens ? message.slice(tokens.length) : message
  const native = Boolean(tokens || item.hasImage)
  if (native && sameText(text, sent.text)) return true
  const attached = text === LEGACY_IMAGE_PROMPT || text.startsWith(LEGACY_IMAGE_PROMPT + '\n')
    ? text.slice(LEGACY_IMAGE_PROMPT.length).trim() : text
  if (native && sameText(attached, sent.text)) return true

  const [paths, ...body] = attached.split('\n\n')
  return paths.split('\n').every(path => STORED_IMAGE_PATH.test(path)) && sameText(body.join('\n\n').trim(), sent.text)
}

