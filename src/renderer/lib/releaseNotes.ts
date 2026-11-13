/**
 * Release notes shown once after an update ("업데이트 내용"). The notes are release-notes/<version>.md
 * in the repository, bundled at build time. The markdown is our own and only a small subset is drawn
 * (headings, bullet lists, paragraphs, `code`, **bold**), as React elements, never as HTML.
 */
export const MAX_VERSIONS_SHOWN = 10

const VERSION = /^\d+\.\d+\.\d+$/

/** Positive when `a` is newer than `b` */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** `{ '<path>/2.14.0.md': text }` (import.meta.glob) → `{ '2.14.0': text }`; other names are ignored */
export function notesFromFiles(files: Record<string, string>): Record<string, string> {
  const notes: Record<string, string> = {}
  for (const [file, text] of Object.entries(files)) {
    const version = file.split('/').pop()?.replace(/\.md$/, '') ?? ''
    if (VERSION.test(version)) notes[version] = text
  }
  return notes
}

export interface VersionNotes { version: string; markdown: string }

/**
 * Notes for the versions after `previous` up to `current`, newest first. With no record, an existing
 * user sees the current version (the first version that has this window); a fresh install sees nothing.
 */
export function notesToShow({ previous, current, existingUser, available }: {
  previous: string | null
  current: string
  existingUser: boolean
  available: Record<string, string>
}): VersionNotes[] {
  if (previous === null && !existingUser) return []
  const isShown = (version: string) => previous === null
    ? version === current
    : compareVersions(version, previous) > 0 && compareVersions(version, current) <= 0
  return Object.keys(available)
    .filter(isShown)
    .sort((a, b) => compareVersions(b, a))
    .slice(0, MAX_VERSIONS_SHOWN)
    .map(version => ({ version, markdown: available[version] }))
}

/** The history for "업데이트 내용 보기": the versions up to `current`, newest first, at most ten */
export function recentNotes(current: string, available: Record<string, string>): VersionNotes[] {
  return Object.keys(available)
    .filter(version => compareVersions(version, current) <= 0)
    .sort((a, b) => compareVersions(b, a))
    .slice(0, MAX_VERSIONS_SHOWN)
    .map(version => ({ version, markdown: available[version] }))
}

export type Inline = { type: 'text' | 'code' | 'bold'; text: string }
export type Block =
  | { type: 'heading'; level: 2 | 3; inlines: Inline[] }
  | { type: 'list'; items: { depth: 0 | 1; inlines: Inline[] }[] }
  | { type: 'paragraph'; inlines: Inline[] }

/** `code` and **bold**; a mark without its closing pair stays as text */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const pushText = (value: string) => {
    if (!value) return
    const last = out[out.length - 1]
    if (last?.type === 'text') out[out.length - 1] = { type: 'text', text: last.text + value }
    else out.push({ type: 'text', text: value })
  }
  let rest = text
  while (rest) {
    const match = /`([^`]+)`|\*\*([^*]+)\*\*/.exec(rest)
    if (!match) {
      pushText(rest)
      break
    }
    pushText(rest.slice(0, match.index))
    out.push(match[1] !== undefined ? { type: 'code', text: match[1] } : { type: 'bold', text: match[2] })
    rest = rest.slice(match.index + match[0].length)
  }
  return out
}

export function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', inlines: parseInline(paragraph.join(' ')) })
    paragraph = []
  }

  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line)
    if (!line.trim()) {
      flush()
    } else if (heading) {
      flush()
      blocks.push({ type: 'heading', level: heading[1].length === 3 ? 3 : 2, inlines: parseInline(heading[2].trim()) })
    } else if (bullet) {
      flush()
      const item = { depth: (bullet[1].length >= 2 ? 1 : 0) as 0 | 1, inlines: parseInline(bullet[2].trim()) }
      const last = blocks[blocks.length - 1]
      if (last?.type === 'list') blocks[blocks.length - 1] = { type: 'list', items: [...last.items, item] }
      else blocks.push({ type: 'list', items: [item] })
    } else {
      paragraph.push(line.trim())
    }
  }
  flush()
  return blocks
}
