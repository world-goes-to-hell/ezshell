import { describe, it, expect } from 'vitest'
import recorderModule from './lineRecorder.js'

const { createLineRecorder, ALT_SCREEN_NOTE } = recorderModule

/** Feed the chunks, finish, and return every recorded line. */
async function record(chunks, size = {}) {
  const lines = []
  const recorder = createLineRecorder({ ...size, onLine: (text) => lines.push(text) })
  for (const chunk of chunks) recorder.write(chunk)
  await recorder.finish()
  return lines
}

describe('createLineRecorder', () => {
  it('records plain lines without colour codes', async () => {
    expect(await record(['\x1b[32muser@host\x1b[0m:~$ ls\r\n', 'a.txt  \x1b[1;34mlogs\x1b[0m\r\n'])).toEqual(['user@host:~$ ls', 'a.txt  logs'])
  })

  it('records the command as it was run, not the keystrokes that edited it', async () => {
    expect(await record(['$ lss\b \b -al\r\n'])).toEqual(['$ ls -al'])
  })

  it('keeps only the final state of a line that was redrawn with carriage returns', async () => {
    expect(await record(['10%\r50%\r100% done\r\n'])).toEqual(['100% done'])
  })

  it('records a command longer than the terminal width as one line', async () => {
    // readline at the right margin: a space and a carriage return force the wrap
    const lines = await record([`$ ${'a'.repeat(18)} \rbbbb\r\n`], { cols: 20, rows: 5 })
    expect(lines).toEqual([`$ ${'a'.repeat(18)}bbbb`])
  })

  it('erases a wide character as one character', async () => {
    expect(await record(['$ echo 한글글\b\b\x1b[K끝\r\n'])).toEqual(['$ echo 한글끝'])
  })

  it('drops the blank left where a character was erased at the end of a line', async () => {
    expect(await record(['$ lss\b \b\r\n', 'prompt$ '])).toEqual(['$ ls', 'prompt$'])
  })

  it('adds no space where a wide character had to move to the next row', async () => {
    // 26 columns: after "... 한글 " one column is left, too narrow for "테", so the terminal leaves it empty
    const chunks = ['tester@test:~$ echo ', '한', '글', ' ', '테', '스', '트', '\r\n']
    expect(await record(chunks, { cols: 26, rows: 5 })).toEqual(['tester@test:~$ echo 한글 테스트'])
  })

  it.each([[10], [11], [12], [13], [14], [15], [16]])('keeps every wide character whatever column the line wraps at (%i columns)', async (cols) => {
    expect(await record(['logs  배포-메모.txt  app.conf\r\n'], { cols, rows: 5 })).toEqual(['logs  배포-메모.txt  app.conf'])
  })

  it('keeps real spaces at a wrap position', async () => {
    expect(await record(['ab cd ef gh\r\n'], { cols: 6, rows: 5 })).toEqual(['ab cd ef gh'])
  })

  it('keeps a multi-byte character whole when it is split across chunks', async () => {
    const bytes = Buffer.from('한글\r\n')
    expect(await record([bytes.subarray(0, 2), bytes.subarray(2)])).toEqual(['한글'])
  })

  it('skips a full-screen program and leaves one note for it', async () => {
    const lines = await record(['$ vim a\r\n', '\x1b[?1049h~\r\n~\r\n-- INSERT --\r\n', '\x1b[?1049l', '$ echo back\r\n'])
    expect(lines).toEqual(['$ vim a', ALT_SCREEN_NOTE, '$ echo back'])
  })

  it('keeps recording after the screen scrolled many times', async () => {
    const chunks = Array.from({ length: 300 }, (_, i) => `line ${i}\r\n`)
    const lines = await record(chunks, { cols: 40, rows: 5 })
    expect(lines).toHaveLength(300)
    expect(lines[299]).toBe('line 299')
  })

  it('records the unfinished last line when it ends', async () => {
    expect(await record(['done\r\n', 'user@host:~$ tail -f app.log'])).toEqual(['done', 'user@host:~$ tail -f app.log'])
  })

  it('does not add an empty last line', async () => {
    expect(await record(['done\r\n'])).toEqual(['done'])
  })

  it('uses the new width after a resize', async () => {
    const lines = []
    const recorder = createLineRecorder({ cols: 10, rows: 5, onLine: (text) => lines.push(text) })
    recorder.resize(40, 5)
    recorder.resize(0, -1)
    recorder.write(`${'x'.repeat(30)}\r\n`)
    await recorder.finish()
    expect(lines).toEqual(['x'.repeat(30)])
  })

  it('does not leave finish() waiting when the recorder is disposed meanwhile', async () => {
    const lines = []
    const recorder = createLineRecorder({ onLine: (text) => lines.push(text) })
    recorder.write('a\r\n')
    const finished = recorder.finish()
    recorder.dispose()
    await expect(finished).resolves.toBeUndefined()
    await expect(recorder.finish()).resolves.toBeUndefined()
    expect(() => { recorder.write('late\r\n'); recorder.resize(100, 30); recorder.dispose() }).not.toThrow()
  })

  it('keeps recording when the line handler throws', async () => {
    let calls = 0
    const recorder = createLineRecorder({ onLine: () => { calls++; throw new Error('disk full') } })
    recorder.write('a\r\nb\r\n')
    await expect(recorder.finish()).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })
})
