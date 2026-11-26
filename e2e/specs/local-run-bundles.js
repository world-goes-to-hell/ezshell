// Run bundles (docs/plan/2026-11-26-multi-repo-and-start-order.md part 3): made from the head's ▾, started and
// stopped from the 모두 실행 spot with only the bundle's presets, refused by main for unknown presets
const fs = require('node:fs')
const path = require('node:path')
const { connect, createChecks, pageProblems, SET, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const folder = path.join(process.env.E2E_PROFILE, 'run-bundles')
const quoted = JSON.stringify(folder)
fs.mkdirSync(folder, { recursive: true })
fs.writeFileSync(path.join(folder, 'service.cjs'), 'console.log(process.argv[2] + " up"); setInterval(() => {}, 1000)\n')

;(async () => {
  const driver = await connect()
  const { js, click, center, until, shot } = driver
  const list = `window.electronAPI.runPresetsList(${quoted})`
  const command = `document.querySelector('.run-command-dialog .btn-primary')`
  const go = `document.querySelector('.run-bundle-go')`
  const dialog = `document.querySelector('.run-bundle-dialog')`
  const requireState = async (condition, timeout = 10000) => { if (!await until(condition, timeout)) throw new Error(condition) }
  try {
    await unlock(driver)
    const ids = {}
    for (const name of ['gateway', 'payment', 'order']) {
      const result = await js(`window.electronAPI.runPresetsSave(${quoted}, ${JSON.stringify({
        name, kind: 'custom', command: `node service.cjs ${name}`, relative: '.', inAll: name !== 'gateway'
      })})`)
      if (!result.preset) throw new Error(result.error)
      ids[name] = result.preset.id
    }
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([folder]))})
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    await requireState(`!!${go}`)
    check('without bundles the head still offers 모두 실행', await js(`${go}.textContent.trim() === '모두 실행'`))

    await click(...await center(`document.querySelector('.run-bundle-more')`))
    await driver.pick('묶음 만들기…')
    await requireState(`!!${dialog}`)
    await js(`(${SET})(document.querySelector('#run-bundle-name'), '주문 개발')`)
    await js(`[...document.querySelectorAll('.run-bundle-preset')].filter(label => ['gateway', 'order'].includes(label.querySelector('.run-bundle-preset-name').textContent)).forEach(label => label.querySelector('input').click())`)
    await shot('local-run-bundle-dialog')
    await js(`[...${dialog}.querySelectorAll('button')].find(button => button.textContent === '만들기').click()`)
    check('the bundle is saved in main and becomes the head’s choice', await until(`(async () => {
      const { bundles } = await ${list}
      return !${dialog} && bundles.length === 1 && bundles[0].name === '주문 개발' &&
        bundles[0].presetIds.slice().sort().join() === ${JSON.stringify([ids.gateway, ids.order].sort().join())} &&
        ${go}.textContent.trim() === '주문 개발 실행'
    })()`))

    await click(...await center(`document.querySelector('.run-bundle-more')`))
    await requireState(`!!document.querySelector('.run-bundle-menu')`)
    check('the bundle includes a preset outside the start order, while 전체 counts only the scheduled presets', await js(`(() => {
      const items = [...document.querySelectorAll('.run-bundle-menu .run-bundle-item')].map(item => item.textContent.trim())
      return items[0] === '주문 개발2개' && items[1] === '전체2개'
    })()`))
    await shot('local-run-bundle-menu')
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await until(`!document.querySelector('.run-bundle-menu')`, 2000)

    await js(`${go}.click()`)
    for (let count = 0; count < 2; count++) {
      await requireState(`${command} && !${command}.disabled`)
      await click(...await center(command))
    }
    check('the named bundle starts only its presets and appends the unscheduled gateway', await until(`(async () => {
      const { states } = await ${list}
      const on = id => ['starting', 'running'].includes(states[id].status)
      return on('${ids.gateway}') && on('${ids.order}') && states['${ids.payment}'].status === 'idle' &&
        states['${ids.order}'].lastAction?.at <= states['${ids.gateway}'].lastAction?.at
    })()`, 15000))
    check('the head offers stopping the bundle', await until(`${go}.textContent.trim() === '주문 개발 중지'`))
    await shot('local-run-bundle-running')
    await js(`${go}.click()`)
    check('stopping the bundle stops its presets', await until(`(async () => {
      const { states } = await ${list}
      return states['${ids.gateway}'].status === 'stopped' && states['${ids.order}'].status === 'stopped'
    })()`, 20000))

    const refused = await js(`window.electronAPI.runPresetBundleSave(${quoted}, { name: '없는 구성', presetIds: ['not-a-preset'] })`)
    check('main refuses a bundle with a preset the project does not have', refused.ok === false, JSON.stringify(refused))
    const problems = await pageProblems(driver)
    check('no page errors', !problems.length, JSON.stringify(problems))
  } finally {
    await js(`window.electronAPI.runPresetStopAll(${quoted})`).catch(() => {})
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
