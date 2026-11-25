// Load the last checked theme in the document head, before the sign-in screen is painted.
(() => {
  'use strict'
  const ansi = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
  const ansiVariables = Object.fromEntries(ansi.flatMap(name => [
    [name, `--t-${name}`],
    [`bright${name[0].toUpperCase()}${name.slice(1)}`, `--t-bright-${name}`]
  ]))
  if (typeof module === 'object' && module.exports) {
    module.exports = { ansiVariables }
    return
  }

  const CACHE_KEY = 'ezshell-remote-theme'
  const root = document.documentElement
  const colors = [
    '--bg', '--panel', '--line', '--text', '--muted', '--accent', '--on-accent', '--focus', '--error', '--danger',
    ...Object.values(ansiVariables)
  ]
  // CSS.supports alone accepts URL-independent values such as var() and bare keywords.
  // Limit stored colors to the literal hex and RGB formats the server sends.
  const isColor = value => typeof value === 'string' && value.length <= 64
    && (/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value) || /^rgba?\([\d., /%]+\)$/i.test(value))
    && CSS.supports('color', value)
  const isRadius = value => typeof value === 'string' && value.length <= 12
    && /^(?:0|\d+(?:\.\d+)?px)$/.test(value) && parseFloat(value) <= 32
  const isFont = value => {
    if (typeof value !== 'string' || value.length > 160 || /[^\x20-\x7e]/.test(value)) return false
    const names = value.split(',').map(name => name.trim())
    return names.length <= 8 && names.every(name => /^(?:[a-z0-9 -]+|'[a-z0-9 -]+'|"[a-z0-9 -]+")$/i.test(name))
      && CSS.supports('font', `13px ${value}`)
  }
  const rules = [
    ...colors.map(key => [key, isColor]),
    ['--radius', isRadius],
    ['--panel-radius', isRadius],
    ['--font', isFont],
    ['--terminal-font', isFont],
    ['--scheme', value => value === 'light' || value === 'dark']
  ]

  function apply(theme) {
    const clean = {}
    for (const [key, accepts] of rules) {
      const value = theme?.[key]
      if (accepts(value)) {
        clean[key] = value
        root.style.setProperty(key, value === '0' && key.endsWith('radius') ? '0px' : value)
      } else root.style.removeProperty(key)
    }
    root.toggleAttribute('data-themed', Object.keys(clean).length > 0)
    document.querySelector('meta[name="theme-color"]').content = clean['--bg'] ?? '#16181c'
    return clean
  }

  try {
    const cached = localStorage.getItem(CACHE_KEY)
    if (cached && cached.length <= 4096) apply(JSON.parse(cached))
  } catch {
    // Storage may be unavailable in private browsing.
  }

  const ns = (window.ezRemote = window.ezRemote || {})
  ns.theme = {
    set(theme) {
      const checked = apply(theme)
      try {
        if (Object.keys(checked).length) localStorage.setItem(CACHE_KEY, JSON.stringify(checked))
        else localStorage.removeItem(CACHE_KEY)
      } catch {
        // Continue with the current theme when storage is unavailable.
      }
    },
    terminalOptions() {
      const style = getComputedStyle(root)
      const token = name => style.getPropertyValue(name).trim()
      const theme = {
        background: token('--bg'), foreground: token('--text'), cursor: token('--terminal-cursor'),
        cursorAccent: token('--terminal-cursor-accent'), selectionBackground: token('--terminal-selection')
      }
      for (const [key, name] of Object.entries(ansiVariables)) {
        const color = token(name)
        if (color) theme[key] = color
      }
      return { theme, fontFamily: token('--terminal-font') || token('--font-mono') || 'ui-monospace, monospace' }
    }
  }
})()
