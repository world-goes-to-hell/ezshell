// The startup motion since 2026-11-20 (design: mockups/startup-boot-prompt.html): a terminal window over the
// desktop, in the colors of the user's theme, where `ezshell --boot` is typed like a person types it, runs,
// prints its boot lines and a new prompt. When the app is ready the window grows into the app's backdrop
// (the cover main shows the app under), then fades away. Nothing to press: it plays by itself.
import type { ThemeDefinition } from '../types/theme'

const COMMAND = 'ezshell --boot'
const BOOT_LINES = ['세션 목록 불러오는 중', '테마와 단축키 적용', '로컬 셸 준비']
/** Before the first key; the pause before Enter; the window growing over the screen; its fade */
const START_MS = 600
const ENTER_PAUSE_MS = 520
const COVER_MS = 380
const FADE_MS = 280

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** The delay before each key, like a person typing: uneven, a pause between words */
function keyDelay(char: string, next: string | undefined): number {
  if (char === ' ') return 150 + Math.random() * 110
  if (next === ' ') return 70 + Math.random() * 60
  return 45 + Math.random() * 75
}

/** The prompt as a shell prints it: user@host:path$ */
function promptLine(): HTMLDivElement {
  const line = element('div', 'boot-line')
  line.append(element('span', 'boot-user', 'ezshell@localhost'), element('span', 'boot-dim', ':'),
    element('span', 'boot-path', '~'), element('span', 'boot-dim', '$ '))
  return line
}

/** The theme's terminal colors as the window's: background, text, green user, blue path, cursor */
function applyTheme(root: HTMLElement, theme: ThemeDefinition) {
  const colors = theme.terminal
  const set = (name: string, value: string | undefined, fallback: string) => root.style.setProperty(name, value || fallback)
  set('--t-bg', colors?.background, theme.colors.bgPrimary || '#16181c')
  set('--t-fg', colors?.foreground, theme.colors.textPrimary || '#d9dee5')
  set('--t-green', colors?.green, '#7ee2a8')
  set('--t-blue', colors?.blue, '#7fb0ff')
  set('--t-cursor', colors?.cursor, colors?.foreground || '#e6edf5')
}

/** Plays the terminal in `root`; resolves when the app is shown and the window has faded */
export async function playBootPromptStartup(root: HTMLElement, theme: ThemeDefinition, readyToReveal: Promise<string>, showApp: () => Promise<void>) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const wait = (ms: number) => sleep(reduced ? 0 : ms)
  applyTheme(root, theme)

  const term = element('section', 'boot-term')
  term.dataset.phase = 'prompt'
  term.setAttribute('aria-hidden', 'true')
  const bar = element('div', 'boot-bar')
  const buttons = element('span', 'boot-buttons')
  buttons.append(element('i'), element('i'), element('i'))
  const shellName = /Mac/i.test(navigator.platform) ? 'zsh' : 'pwsh'
  bar.append(buttons, element('span', 'boot-title', `ezShell — ${shellName}`))
  const body = element('div', 'boot-body')
  term.append(bar, body)
  const status = element('span', 'boot-status')
  status.setAttribute('role', 'status')
  root.append(term, status)

  const line = promptLine()
  const typed = element('span')
  const caret = element('span', 'boot-cursor')
  line.append(typed, caret)
  body.append(line)
  await wait(START_MS)

  term.dataset.phase = 'typing'
  for (let index = 0; index < COMMAND.length; index++) {
    typed.textContent = reduced ? COMMAND : typed.textContent + COMMAND[index]
    if (reduced) break
    await sleep(keyDelay(COMMAND[index], COMMAND[index + 1]))
  }

  // A short pause with the cursor blinking, as before a person presses Enter; then it runs
  term.dataset.phase = 'waiting'
  await wait(ENTER_PAUSE_MS)
  caret.remove()
  term.dataset.phase = 'booting'
  status.textContent = 'ezShell 시작 중'
  for (const text of BOOT_LINES) {
    await wait(120 + Math.random() * 90)
    const out = element('div', 'boot-line')
    out.append(element('span', 'boot-dim', '['), element('span', 'boot-ok', ' ok '), element('span', 'boot-dim', '] '), element('span', undefined, text))
    body.append(out)
  }
  await wait(160)
  const ready = promptLine()
  ready.append(element('span', 'boot-cursor'))
  body.append(ready)
  term.dataset.phase = 'waiting'

  // The app may still be loading: the new prompt blinks until it is ready
  const color = await readyToReveal
  term.style.setProperty('--cover', color)
  term.dataset.phase = 'covering'
  await wait(COVER_MS)
  await showApp()
  term.dataset.phase = 'leaving'
  await wait(FADE_MS)
}
