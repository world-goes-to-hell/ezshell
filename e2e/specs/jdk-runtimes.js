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

    const provider = `document.querySelector('.jdk-choice-row select')`
    await js(`((select) => { select.value = 'jbr'; select.dispatchEvent(new Event('change', { bubbles: true })) })(${provider})`)
    check('offers only JetBrains Runtime 21 and 17', await until(`
      [...${version}.options].map(option => option.value).join(',') === '21,17' &&
      (${button('받아 두기')})?.disabled === false
    `))
    await click('받아 두기')
    const jbrRow = `document.querySelector('.jdk-list [aria-label="21.0.11+1163.125 지우기"]')`
    check('shows the installed SDK in the managed list', await until(`
      ${jbrRow}?.closest('li').textContent.includes('JetBrains Runtime 21.0.11+1163.125')
    `))
    check('shows the HotswapAgent license before installation', await js(`!!(${button('HotswapAgent 라이선스')})`))
    await click('HotswapAgent 받기')
    const agentRow = `document.querySelector('.jdk-settings [aria-label="HotswapAgent 지우기"]')`
    check('shows installed HotswapAgent version and makes it available to run presets', await until(`
      (async () => ${agentRow}?.closest('li').textContent.includes('HotswapAgent 2.0.5') &&
        (await window.electronAPI.runtimesList()).hotswapAgent.version === '2.0.5')()
    `))
    // The tab with a downloaded JBR, HotswapAgent and the PC's JDKs, top and bottom (design review)
    const scrollTab = to => js(`(() => { const box = document.querySelector('.jdk-settings').closest('.settings-content') ?? document.querySelector('.jdk-settings').parentElement; box.scrollTop = ${to}; })()`)
    await scrollTab(0)
    await driver.shot(`devtools-${process.env.DEVTOOLS_SHOT ?? 'now'}-1`)
    await scrollTab(100000)
    await driver.shot(`devtools-${process.env.DEVTOOLS_SHOT ?? 'now'}-2`)
    await js(`${agentRow}.click()`)
    if (!await until(`!!(${button('삭제 확인')})`)) throw new Error('HotswapAgent removal confirmation missing')
    await click('삭제 확인')
    check('removes HotswapAgent independently of the JBR SDK', await until(`
      (async () => !!(${button('HotswapAgent 받기')}) && !!${jbrRow} &&
        !(await window.electronAPI.runtimesList()).hotswapAgent.installed)()
    `))

    await click('개발 도구 받기')
    const apacheVersion = `document.querySelector('.apache-tools .jdk-choice-row label:nth-child(2) select')`
    await js(`((select) => { select.value = '6'; select.dispatchEvent(new Event('change', { bubbles: true })) })(${apacheVersion})`)
    check('explains the blocked Tomcat 6 download and offers registration and Tomcat 7', await until(`
      document.querySelector('.apache-tools').textContent.includes('SHA-512') &&
      !!(${button('Tomcat 6 폴더 등록')}) && !!(${button('Tomcat 7 받기')}) && !(${button('도구 받아 두기')})
    `))
    await click('Tomcat 6 폴더 등록')
    const registered = await until(`
      (async () => [...document.querySelectorAll('.apache-tools .jdk-list li')].some(row =>
        row.textContent.includes('Tomcat 6.0.53') && row.textContent.includes('이 PC')) &&
        (await window.electronAPI.runtimesList()).tools.some(tool => tool.tool === 'tomcat' && tool.series === '6' && !tool.managed && !tool.home))()
    `)
    if (!registered) {
      const details = await js(`(async () => ({
        alerts: [...document.querySelectorAll('.jdk-settings [role="alert"]')].map(el => el.textContent.trim()),
        tools: (await window.electronAPI.runtimesList()).tools?.map(({tool, version, series, managed}) => ({tool, version, series, managed}))
      }))()`)
      throw new Error(`Tomcat registration failed: ${JSON.stringify(details)}`)
    }
    check('registers an existing Tomcat as a discovered tool without exposing its home', registered)
    await click('Tomcat 7 받기')
    check('shows the Tomcat 7 release and license before installing', await until(`
      ${apacheVersion}?.value === '7' && (${button('Apache 라이선스 보기')})?.title.includes('LICENSE-2.0') &&
      (${button('도구 받아 두기')})?.disabled === false
    `))
    await click('도구 받아 두기')
    const tomcatRow = `document.querySelector('.apache-tools [aria-label="Tomcat 7.0.109 지우기"]')`
    check('adds the verified Tomcat to the managed list', await until(`
      !!${tomcatRow} && (async () => (await window.electronAPI.runtimesList()).tools.some(tool =>
        tool.id === 'tomcat-7.0.109' && tool.managed && !tool.home))()
    `))
    await js(`${tomcatRow}.click()`)
    if (!await until(`!!(${button('삭제 확인')})`)) throw new Error('Apache removal confirmation missing')
    await click('삭제 확인')
    check('removes only the managed Tomcat', await until(`
      (async () => !${tomcatRow} && (await window.electronAPI.runtimesList()).tools.some(tool =>
        tool.tool === 'tomcat' && tool.series === '6' && !tool.managed))()
    `))

    check('lists an existing Node.js without its absolute home', await until(`
      (async () => document.querySelector('.apache-tools .jdk-list').textContent.includes('Node.js 24.14.0') &&
        (await window.electronAPI.runtimesList()).tools.some(tool => tool.tool === 'node' && tool.version === '24.14.0' && !tool.managed && !tool.home))()
    `))
    await js(`document.querySelector('.apache-tools').scrollIntoView({ block: 'start' })`)
    await driver.shot(`devtools-${process.env.DEVTOOLS_SHOT ?? 'now'}-3`)
    const toolSelect = `document.querySelector('.apache-tools .jdk-choice-row label:first-child select')`
    for (const [tool, series, name, version] of [['gradle', 'current', 'Gradle', '9.9.2'], ['node', 'lts', 'Node.js', '26.13.1']]) {
      await js(`((select) => { select.value = '${tool}'; select.dispatchEvent(new Event('change', { bubbles: true })) })(${toolSelect})`)
      check(`shows ${name} ${version} and its license`, await until(`
        ${apacheVersion}?.value === '${series}' && !!(${button(`${name} 라이선스 보기`)})?.title &&
        document.querySelector('.apache-tools .jdk-download').textContent.includes('${name} ${version}') &&
        (${button('도구 받아 두기')})?.disabled === false
      `))
      await click('도구 받아 두기')
      const row = `document.querySelector('.apache-tools [aria-label="${name} ${version} 지우기"]')`
      check(`installs and lists verified ${name}`, await until(`
        !!${row} && (async () => (await window.electronAPI.runtimesList()).tools.some(tool => tool.id === '${tool}-${version}' && tool.managed && !tool.home))()
      `))
      await js(`${row}.click()`)
      await click('삭제 확인')
      check(`removes managed ${name}`, await until(`!${row}`))
    }
  } finally { driver.close() }
}

run().then(finish).catch(error => { console.error(error); process.exitCode = 1 })
