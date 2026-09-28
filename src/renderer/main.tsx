import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'

// Suppress ResizeObserver loop warning (harmless)
const resizeObserverErr = window.onerror
window.onerror = (message, ...args) => {
  if (typeof message === 'string' && message.includes('ResizeObserver loop')) {
    return true
  }
  return resizeObserverErr ? resizeObserverErr(message, ...args) : false
}

// Bundled fonts load lazily on first use. Warm up the terminal fonts so the first
// Hangul output is not drawn with a fallback font and then swapped.
if (document.fonts?.load) {
  Promise.all([
    document.fonts.load('14px "JetBrains Mono"'),
    document.fonts.load('14px "D2Coding"', '가')
  ]).catch(() => { /* fall back to system fonts */ })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
