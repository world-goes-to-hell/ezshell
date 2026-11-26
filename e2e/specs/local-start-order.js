const fs = require('node:fs')
const path = require('node:path')
const { connect, createChecks, pageProblems, SET, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const folder = path.join(process.env.E2E_PROFILE, 'startup-order')
const quoted = JSON.stringify(folder)
fs.mkdirSync(folder, { recursive: true })
fs.writeFileSync(path.join(folder, 'service.cjs'), `
  const fs = require('node:fs')
  const name = process.argv[2]
  console.log(name + ' ready in 1 ms')
  const wait = setInterval(() => {
    if (!fs.existsSync('ready-' + name)) return
    clearInterval(wait)
    console.log('fixture healthy')
  }, 50)
  setInterval(() => {}, 1000)
`)

;(async () => {
  const driver = await connect()
  const { js, click, center, until, shot } = driver
  const list = `window.electronAPI.runPresetsList(${quoted})`
  const runStates = () => js(`(async () => Object.fromEntries(Object.entries((await ${list}).states).map(([id, state]) =>
    [id, { status: state.status, exitCode: state.exitCode, action: state.lastAction }])) )()`)
  const orderDialog = `document.querySelector('.run-order-dialog')`
  const currentStages = `[...document.querySelectorAll('.run-order-stage:has(.run-order-stage-head)')]`
  const command = `document.querySelector('.run-command-dialog .btn-primary')`
  const button = (selector, title) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim() === ${JSON.stringify(title)})`
  const row = id => `document.querySelector('.run-preset[data-run-preset="${id}"]')`
  const set = (selector, value) => js(`(${SET})(document.querySelector(${JSON.stringify(selector)}), ${JSON.stringify(value)})`)
  const requireState = async (condition, timeout = 10000) => { if (!await until(condition, timeout)) throw new Error(condition) }
  try {
    await unlock(driver)
    const services = {}
    for (const name of ['Config', 'Catalog', 'Gateway']) {
      const result = await js(`window.electronAPI.runPresetsSave(${quoted}, ${JSON.stringify({
        name, kind: 'custom', command: `node service.cjs ${name}`, relative: '.'
      })})`)
      if (!result.preset) throw new Error(result.error)
      services[name] = result.preset.id
    }
    const { Config, Catalog, Gateway } = services
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([folder]))})
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    const orderMenu = `document.querySelector('button[aria-label="실행 구성 메뉴"]')`
    await requireState(`!!${orderMenu}`)
    await click(...await center(orderMenu))
    await driver.pick('기동 순서…')
    check('the order editor opens with the existing presets in three stages', await until(`!!${orderDialog} && ${currentStages}.length === 3`))
    await js(`(() => {
      const stages = ${currentStages}
      const transfer = new DataTransfer()
      const options = { bubbles: true, cancelable: true, dataTransfer: transfer }
      const service = stages[1].querySelector('.run-order-service')
      service.dispatchEvent(new DragEvent('dragstart', options))
      stages[0].dispatchEvent(new DragEvent('dragover', options))
      stages[0].dispatchEvent(new DragEvent('drop', options))
      service.dispatchEvent(new DragEvent('dragend', options))
    })()`)
    check('dragging a preset into an existing stage puts both services together', await until(`
      ${currentStages}.length === 2 && ${currentStages}[0].querySelectorAll('.run-order-service').length === 2
    `))
    check('the last stage is marked without an unused gate selector', await js(`
      ${currentStages}.at(-1).querySelector('.run-order-last')?.textContent === '마지막' &&
      !${currentStages}.at(-1).querySelector('.run-order-stage-head select')
    `))
    await js(`(() => { const input = ${currentStages}[0].querySelector('.run-order-stage-head select'); input.value = 'log'; input.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await requireState(`!!document.querySelector('.run-order-value input')`)
    await set('.run-order-value input', 'fixture healthy')
    const minutesInput = 'input[aria-label="대기 시간 분"]'
    const secondsInput = 'input[aria-label="대기 시간 초"]'
    check('the default wait is displayed as five minutes', await js(`
      document.querySelector(${JSON.stringify(minutesInput)}).valueAsNumber === 5 &&
      document.querySelector(${JSON.stringify(secondsInput)}).valueAsNumber === 0
    `))
    await set(secondsInput, '-7')
    check('the wait input refuses negative seconds', await js(`document.querySelector(${JSON.stringify(secondsInput)}).valueAsNumber === 0`))
    await shot('local-start-order-editor')
    await set(minutesInput, '0')
    await set(secondsInput, '5')
    await js(`${orderDialog}.querySelector('button[type="submit"]').click()`)
    check('save persists the parallel stage and its log criterion', await until(`(async () => {
      const { startOrder } = await ${list}
      return !${orderDialog} && startOrder.timeoutSeconds === 5 && startOrder.stages[0].ids.join(',') === '${Config},${Catalog}' &&
        startOrder.stages[0].gate.value === 'fixture healthy'
    })()`))

    await js(`${button('.run-presets-head button', '모두 실행')}.click()`)
    for (let count = 0; count < 3; count++) {
      await requireState(`${command} && !${command}.disabled`)
      await click(...await center(command))
    }
    check('the sidebar shows stage numbers and the log wait while the following stage is queued', await until(`
      document.querySelector('.run-start-progress')?.max === 2 &&
      !!${row(Config)}?.querySelector('[data-wait="log"]') && !!${row(Catalog)}?.querySelector('[data-wait="log"]') &&
      !!${row(Gateway)}?.querySelector('[data-wait="queued"]') &&
      ${row(Config)}?.querySelector('.run-start-step')?.textContent === '1' &&
      ${row(Gateway)}?.querySelector('.run-start-step')?.textContent === '2'
    `, 6000), JSON.stringify(await js(`[...document.querySelectorAll('.run-start-wait')].map(wait => wait.textContent)`)))
    fs.writeFileSync(path.join(folder, 'ready-Config'), '')
    check('a missing acknowledgment pauses the batch without launching the last stage', await until(`
      document.querySelector('.run-start-recovery')?.textContent.includes('Catalog') &&
      ${row(Gateway)}?.dataset.status === 'idle'
    `))
    check('the pause warning offers retry as its primary action', await js(`(() => {
      const recovery = document.querySelector('.run-start-recovery')
      return recovery?.querySelector('.btn-primary')?.textContent.trim() === '다시 시도' &&
        [...recovery.querySelectorAll('button')].map(button => button.textContent.trim()).join('|') === '로그 보기|건너뛰고 계속|취소|다시 시도' &&
        getComputedStyle(recovery).borderTopColor !== getComputedStyle(recovery).backgroundColor
    })()`))
    await shot('local-start-order-paused')
    fs.writeFileSync(path.join(folder, 'ready-Catalog'), '')
    await js(`${button('.run-start-recovery button', '다시 시도')}.click()`)
    check('retry continues when the remaining service matches the log criterion', await until(`(async () => {
      const snapshot = await ${list}
      return !snapshot.batch && snapshot.states['${Gateway}'].status === 'running'
    })()`))
    await js(`${button('.run-presets-head button', '모두 중지')}.click()`)
    check('stop all stops each stage’s running services', await until(`(async () => {
      const snapshot = await ${list}
      return Object.values(snapshot.states).every(state => state.status === 'stopped')
    })()`, 20000), JSON.stringify(await runStates()))
    await js(`${row(Gateway)}.querySelector('[data-action="start"]').click()`)
    check('starting the last service asks about the earlier, stopped stage', await until(`
      document.querySelector('.run-command-dialog')?.textContent.includes('앞 단계도 함께 띄울까요?') &&
      document.querySelector('.run-command-dialog')?.textContent.includes('Config')
    `))
    await js(`${button('.run-command-dialog button', '이 구성만 실행')}.click()`)
    check('choosing just this service keeps the earlier stage stopped', await until(`(async () => {
      const snapshot = await ${list}
      return snapshot.states['${Config}'].status === 'stopped' && snapshot.states['${Catalog}'].status === 'stopped' &&
        ['running', 'starting'].includes(snapshot.states['${Gateway}'].status)
    })()`), JSON.stringify(await runStates()))
    const problems = await pageProblems(driver)
    check('no page errors', !problems.length, JSON.stringify(problems))
  } finally {
    await js(`window.electronAPI.runPresetStopAll(${quoted})`).catch(() => {})
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
