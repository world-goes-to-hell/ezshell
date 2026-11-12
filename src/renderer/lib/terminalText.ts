// The whole output of a terminal (scrollback and screen) as plain text, for "전체 출력 복사" / "출력 저장".

interface BufferLine {
  isWrapped: boolean
  translateToString: (trimRight?: boolean) => string
}

export interface TerminalBuffer {
  length: number
  getLine: (index: number) => BufferLine | undefined
}

/** A line the terminal wrapped at its width is joined back into one; empty lines at the end are dropped */
export function bufferText(buffer: TerminalBuffer): string {
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    if (!line) continue
    const text = line.translateToString(true)
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text
    else lines.push(text)
  }
  let end = lines.length
  while (end > 0 && lines[end - 1] === '') end--
  return lines.slice(0, end).join('\n')
}

/** File name for saved output: the tab's name without path characters, and the time */
export function outputFileName(tabName: string, now: Date): string {
  const safe = tabName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60) || 'terminal'
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${safe}_${stamp}.txt`
}

/** What the find dialog starts with: a one-line selection of a sensible length, otherwise nothing */
export function findQueryFromSelection(selection: string, maxLength: number): string {
  const text = selection.trim()
  if (!text || text.length > maxLength || /[\r\n\u0000-\u001f]/.test(text)) return ''
  return text
}
