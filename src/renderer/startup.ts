// The startup splash (main.js createStartupSplash): plays a motion over the desktop while the app loads,
// then covers the window with the app's backdrop, lets main show the app under it and fades away.
// The motion since 2026-11-20 is a terminal typing `ezshell --boot` in the theme's colors (startupMotions/
// bootPrompt.ts); the dot logo before it is kept in startupMotions/dotLogo.ts
// (to play it again: `playDotLogoStartup(root, theme, readyToReveal, showApp)` below, and its styles are
// still in styles/startup.css).
import { playBootPromptStartup } from './startupMotions/bootPrompt'
import { useThemeStore } from './stores/themeStore'

async function start() {
  const theme = useThemeStore.getState().getCurrentTheme()
  const root = document.querySelector<HTMLElement>('.startup')!
  const managed = new URLSearchParams(location.search).has('startupMode')
  const readyToReveal = managed
    ? new Promise<string>(resolve => window.addEventListener('ezshell-startup-reveal',
      event => resolve((event as CustomEvent<string>).detail || theme.colors.bgPrimary), { once: true }))
    : Promise.resolve(theme.colors.bgPrimary)
  const showApp = managed
    ? () => new Promise<void>(resolve => {
      window.addEventListener('ezshell-startup-app-shown', () => resolve(), { once: true })
      requestAnimationFrame(() => window.dispatchEvent(new Event('ezshell-startup-covered')))
    })
    : () => Promise.resolve()
  try {
    await playBootPromptStartup(root, theme, readyToReveal, showApp)
  } catch {
    await readyToReveal
  }
  window.dispatchEvent(new Event('ezshell-startup-finished'))
}

void start()
