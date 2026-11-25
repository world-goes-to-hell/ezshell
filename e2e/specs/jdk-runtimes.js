const fs = require('node:fs')
const path = require('node:path')
const { connect, createChecks, unlock } = require('../support/driver')

const { check, finish } = createChecks()

async function run() {
  if (process.env.E2E_APP) {
    console.log('SKIP JDK provider fixture requires the development build')
    return
  }
  const driver = await connect()
  const { send, js, until } = driver
  const button = label => `[...document.querySelectorAll('.jdk-settings button')].find(el => el.textContent.trim() === ${JSON.stringify(label)})`
  const click = label => js(`${button(label)}.click()`)
  const row = `document.querySelector('.jdk-list [aria-label="17.0.21.1+2 지우기"]')`
  const index = path.join(process.env.E2E_PROFILE, 'runtimes.json')

  try {
    await unlock(driver)
    const comma = { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...comma })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...comma })
    const tab = `[...document.querySelectorAll('.settings-tabs-list [role="tab"]')].find(el => el.textContent.trim() === '개발 도구')`
    if (!await until(`!!(${tab})`)) throw new Error('개발 도구 tab missing')
    await js(`(${tab}).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
    if (!await until(`!!(${button('JDK 받기')})`)) throw new Error('JDK settings missing')
    await click('JDK 받기')
    check('shows the provider license before the download', await until(`
      !!(${button('라이선스 보기')})?.title && (${button('받아 두기')})?.disabled === false
    `))
    const ready = await until(`(${button('받아 두기')})?.disabled === false`)
    if (!ready) throw new Error('fixture provider failed')
    await click('받아 두기')
    check('shows the downloaded JDK and installed size in the managed list', await until(`
      ${row}?.closest('li').textContent.includes('Eclipse Temurin 17.0.21.1+2') &&
      ${row}.closest('li').textContent.includes('바이트')
    `))
    const installed = fs.existsSync(index) && JSON.parse(fs.readFileSync(index, 'utf8')).jdks[0]
    check('registers the JDK under the app profile', installed?.managed &&
      fs.existsSync(path.join(process.env.E2E_PROFILE, 'runtimes', 'jdk', installed.id, 'bin', 'java.exe')))
    await js(`${row}.click()`)
    if (!await until(`!!(${button('삭제 확인')})`)) throw new Error('JDK removal confirmation missing')
    await click('삭제 확인')
    check('removes the managed JDK and updates the list', await until(`!${row} && document.body.textContent.includes('받은 JDK가 없습니다.')`) &&
      JSON.parse(fs.readFileSync(index, 'utf8')).jdks.length === 0)
    const version = `document.querySelector('.jdk-choice-row label:nth-child(2) select')`
    await js(`((select) => { select.value = '7'; select.dispatchEvent(new Event('change', { bubbles: true })) })(${version})`)
    check('shows a JDK 8 fallback when a legacy public build is unavailable', await until(`!!(${button('JDK 8로 받기')})`))
    await click('JDK 8로 받기')
    check('selects JDK 8 for review before downloading', await until(`${version}?.value === '8'`))
  } finally { driver.close() }
}

run().then(finish).catch(error => { console.error(error); process.exitCode = 1 })
