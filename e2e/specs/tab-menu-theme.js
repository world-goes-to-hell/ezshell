// Right-click terminal tab menu: the selected theme stays readable over either terminal palette.
const { connect, createChecks, unlock } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { center, click, js, send, shot, until } = driver
  const press = async key => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }
  try {
    await unlock(driver)
    await js(`document.querySelector('.local-terms-btn[aria-label="새 로컬 터미널"]').click()`)
    await until("!!document.querySelector('.terminal-tab')")

    for (const { name, id, surface } of [
      { name: 'macOS Light', id: 'macos-light', surface: 'flat' },
      { name: 'macOS Light', id: 'macos-light', surface: 'glass' },
      { name: 'macOS Dark', id: 'macos-dark', surface: 'flat' }
    ]) {
      await press({ key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 })
      await until("!!document.querySelector('.theme-grid')")
      await js(`[...document.querySelectorAll('.theme-card-main')].find(button =>
        button.querySelector('.theme-name').textContent === ${JSON.stringify(name)}).click()`)
      const surfaceLabel = surface === 'glass' ? 'Glass' : '플랫'
      await js(`[...document.querySelectorAll('.appearance-segment button')].find(button =>
        button.textContent.trim() === ${JSON.stringify(surfaceLabel)}).click()`)
      await until(`document.documentElement.dataset.theme === '${id}' && document.documentElement.dataset.surface === '${surface}'`)
      await press({ key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await until("!document.querySelector('.settings-modal')")

      const [x, y] = await center("document.querySelector('.terminal-tab')")
      await click(x, y, 'right')
      await until("document.querySelector('.tab-context-menu') && getComputedStyle(document.querySelector('.tab-context-menu')).opacity === '1'")
      const measured = await js(`(() => {
        const menu = document.querySelector('.tab-context-menu')
        const item = menu.querySelector('.menu-item')
        const style = getComputedStyle(menu)
        const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
        const pixel = (color, behind) => {
          context.clearRect(0, 0, 1, 1)
          if (behind) {
            context.fillStyle = behind
            context.fillRect(0, 0, 1, 1)
          }
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
          return Array.from(context.getImageData(0, 0, 1, 1).data)
        }
        const luminance = channels => channels.slice(0, 3).reduce((sum, value, i) => {
          const srgb = value / 255
          const linear = srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
          return sum + [0.2126, 0.7152, 0.0722][i] * linear
        }, 0)
        const text = luminance(pixel(getComputedStyle(item).color))
        const ratios = ['black', 'white'].map(behind => {
          const background = luminance(pixel(style.backgroundColor, behind))
          return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05)
        })
        return { ratio: Math.min(...ratios), opacity: pixel(style.backgroundColor)[3], blur: style.backdropFilter }
      })()`)
      check(`${id} ${surface} menu text contrasts against either backdrop`, measured.ratio >= 4.5, JSON.stringify(measured))
      // Systems asking for reduced transparency keep a flat menu on Glass too.
      const glass = surface === 'glass' && !await js("matchMedia('(prefers-reduced-transparency: reduce)').matches")
      check(`${id} ${surface} uses the requested surface`, glass
        ? measured.opacity < 255 && measured.blur.includes('blur')
        : measured.opacity === 255 && measured.blur === 'none', JSON.stringify(measured))
      await shot(`tab-menu-${id}-${surface}`)
      await js("document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))")
      await until("!document.querySelector('.tab-context-menu')")
    }
  } finally {
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
