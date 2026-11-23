const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createChecks } = require('../support/driver')

const cases = [
  ['kakao-mode', ['#f8fbff', '#202b3d', '#216044', '#265692', '#805800']],
  ['minimal-light', ['#ffffff', '#16181c', '#1f8a55', '#2f6fed', '#2f6fed']],
  ['minimal-dark', ['#121315', '#e6e8eb', '#2fa66a', '#4c8dff', '#4c8dff']],
  ['macos-dark', ['#1e1e1e', '#e8e8ea', '#32d74b', '#0a84ff', '#a0a0a5']]
]
const rgb = hex => `rgb(${hex.slice(1).match(/../g).map(part => parseInt(part, 16)).join(', ')})`
const { check, finish } = createChecks()

if (process.env.E2E_APP) {
  console.log('SKIP the startup profile fixture needs the development build')
  finish()
}

const fixture = path.join(__dirname, '../support/startupThemeApp.js')
for (const [id, palette] of cases) {
  const profile = path.join(process.env.E2E_PROFILE, id)
  fs.mkdirSync(profile)
  const args = [fixture, `--user-data-dir=${profile}`]
  const options = {
    encoding: 'utf8', timeout: 25_000, env: { ...process.env, E2E_STARTUP_THEME: id }
  }
  const seeded = spawnSync(require('electron'), [...args, '--seed-startup-theme'], options)
  if (seeded.status !== 0) {
    check(`${id} saves the theme before startup`, false, seeded.error?.message ?? seeded.stderr)
    continue
  }
  const child = spawnSync(require('electron'), args, options)
  if (child.status !== 0) {
    check(`${id} opens the built startup window`, false, child.error?.message ?? child.stderr)
    continue
  }
  const observed = JSON.parse(fs.readFileSync(path.join(profile, 'startup-theme.json'), 'utf8'))
  const mac = id === 'macos-dark'
  check(`${id} boot and main window use the stored theme`,
    observed.savedTheme === id && observed.theme === id && observed.mainTheme === id, JSON.stringify(observed))
  check(`${id} boot uses the exact terminal colors and keeps the desktop visible around the frame`,
    JSON.stringify(observed.palette) === JSON.stringify(palette) &&
    observed.bodyColor === rgb(palette[0]) && observed.inkColor === rgb(palette[1]) &&
    observed.outsideColor === 'rgba(0, 0, 0, 0)')
  check(`${id} boot uses matching window controls`, observed.controlsOnLeft === mac &&
    observed.bodyRadius === (mac ? '10px' : '4px') && observed.chrome === (mac ? 'mac' : 'default') &&
    observed.controlColor === (mac ? 'rgb(255, 95, 87)' : 'rgba(0, 0, 0, 0)'))
  check(`${id} reveals the main window without a CSP error`, observed.mainShown && observed.violations.length === 0)
}
finish()
