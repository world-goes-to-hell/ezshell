const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { stripVTControlCharacters } = require('node:util')
const { connect, createChecks, pageProblems, sleep, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const project = path.join(process.env.E2E_PROFILE, 'Proposal fixture')
const name = 'Maven 설정 시험'
const mirror = 'https://mirror.example.test/maven/'
const newerMirror = 'https://alternate.example.test/maven/'

function fixture() {
  fs.mkdirSync(project)
  fs.writeFileSync(path.join(project, 'pom.xml'), '<project>spring-boot-maven-plugin</project>')
  fs.writeFileSync(path.join(project, 'mvnw.cmd'), '@echo off\r\nnode fail.cjs\r\n')
  fs.writeFileSync(path.join(project, 'mvnw'), '#!/bin/sh\nexec node fail.cjs\n', { mode: 0o755 })
  fs.writeFileSync(path.join(project, 'fail.cjs'), `
    console.error('[ERROR] Could not transfer artifact sample:demo:jar:1 from/to maven-default-http-blocker (http://0.0.0.0/): Blocked mirror for repositories: [legacy (http://legacy.invalid/maven/, default)] password=fixture-maven-secret');
    process.exitCode = 1;
  `)
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'pipe', windowsHide: true })
  git('init', '-b', 'main')
  git('add', '.')
  git('-c', 'core.hooksPath=.git/no-hooks', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Proposal fixture')
}

async function run() {
  fixture()
  const driver = await connect()
  const { js, until } = driver
  let shellId
  try {
    await unlock(driver)
    const folder = JSON.stringify(project)
    const { preset } = await js(`window.electronAPI.runPresetsSave(${folder}, ${JSON.stringify({
      name, kind: 'task', taskId: '.:maven', notify: false, agentControl: false
    })})`)
    if (!preset) throw new Error('Could not save the Maven run preset')
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([project]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    const id = JSON.stringify(preset.id)
    const args = `${folder}, ${id}`
    const row = `document.querySelector('[data-run-preset="${preset.id}"]')`
    if (!await until(`!!${row}`)) throw new Error('Could not find the Maven card')
    let started = await js(`window.electronAPI.runPresetStart(${args})`)
    if (started.needsConfirm) started = await js(`window.electronAPI.runPresetStart(${args}, { confirmCustom: true })`)
    if (!started.ok || !await until(`${row}?.dataset.status === 'crashed'`, 13000)) {
      throw new Error('The Maven fixture did not exit with a failure')
    }
    const diagnose = `window.electronAPI.runPresetDiagnosis(${args})`
    if (!await until(`(async () => (await ${diagnose}).suggestions?.some(item =>
      item.kind === 'mavenHttpBlocked' && item.repositoryId === 'legacy' && item.apply === 'mavenMirror'))()`, 15000)) {
      throw new Error('The app did not diagnose the fixture Maven HTTP blocker')
    }

    // Use the ordinary shell and the authenticated MCP bridge from a Node fixture.
    const shell = await js(`window.electronAPI.localShellOpen({ cwd: ${folder}, cols: 80, rows: 24 })`)
    if (!shell?.success) throw new Error('Could not open the proposal agent fixture shell')
    shellId = shell.id
    const attached = `window.electronAPI.localShellAttach(${JSON.stringify(shellId)})`
    const output = async () => stripVTControlCharacters((await js(attached))?.backlog ?? '').trimEnd()
    let prompt = await output()
    for (let attempt = 0; attempt < 80 && !/[>$#%]$/.test(prompt); attempt++) { await sleep(150); prompt = await output() }
    if (!/[>$#%]$/.test(prompt)) throw new Error('The proposal fixture shell did not show a command prompt')
    const script = path.join(__dirname, '..', 'support', 'runProposalAgent.js')
    const resultFile = path.join(project, 'proposal-result.json')
    const quote = value => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
    const command = `node ${[script, name, mirror, newerMirror, resultFile].map(quote).join(' ')}\r`
    await js(`window.electronAPI.localShellWrite(${JSON.stringify(shellId)}, ${JSON.stringify(command)})`)
    const result = () => {
      try { return JSON.parse(fs.readFileSync(resultFile, 'utf8')) } catch { return null }
    }
    const proposalDeadline = Date.now() + 55_000
    while (!['pending', 'error'].includes(result()?.status) && Date.now() < proposalDeadline) await sleep(150)
    const submitted = result()
    if (submitted?.status !== 'pending' || !submitted.by) {
      const terminal = (await output()).slice(-500)
      throw new Error(`The shell-bound agent could not submit the proposal: ${JSON.stringify(submitted)}\n${terminal}`)
    }
    const preview = await js(`window.electronAPI.runPresetSendPreview(${args}, '다시 확인해 주세요. secret=fixture-handoff-secret')`)
    if (!preview.token || !preview.text?.includes('secret=****') || preview.text.includes('fixture-handoff-secret')) {
      throw new Error('The hand-off preview did not mask the fixture credential')
    }
    const sent = await js(`window.electronAPI.runPresetSend(${args}, ${JSON.stringify(submitted.by)}, ${JSON.stringify(preview.token)})`)
    if (!sent.ok) throw new Error(`The previewed body could not be sent: ${sent.error}`)

    const view = `[...(${row})?.querySelectorAll('button') ?? []].find(button => button.textContent.trim() === '보기')`
    const visible = await until(`!!(${view}) && ${row}.textContent.includes(${JSON.stringify(submitted.by)})`)
    check('the Maven card shows the proposed fix and the MCP agent who sent it', visible)
    if (!visible) throw new Error('Could not find the proposal card')

    await js(`(${view}).click()`)
    const dialog = `document.querySelector('.run-suggestions-dialog')`
    const urlInput = `${dialog}?.querySelector('[id^="run-suggestion-url-"]')`
    const chosen = `(await window.electronAPI.runPresetsList(${folder})).presets.find(item => item.id === ${id})`
    if (!await until(`${urlInput}?.value === ${JSON.stringify(newerMirror)}`)) throw new Error('The latest proposal was not prefilled')
    await js(`[...${dialog}.querySelectorAll('button')].find(button => button.textContent.trim() === '버리기').click()`)
    const reviewReady = await until(`
      (async () => ${urlInput}?.value === ${JSON.stringify(mirror)} &&
        ${dialog}.textContent.includes('테스트 미러 주소를 확인해 주세요. token=****') &&
        !${dialog}.textContent.includes('fixture-proposal-secret') &&
        ${dialog}.textContent.includes(${JSON.stringify(mirror)}) && !(${chosen}).mavenMirrors)()`)
    check('discarding the latest proposal prefills the next mirror and waits for the user', reviewReady)
    if (!reviewReady) throw new Error('The remaining proposal was not prefilled after discarding the latest')
    await js(`[...${dialog}.querySelectorAll('button')].find(button => button.textContent.trim() === '이 주소로 대체').click()`)
    const closed = await until(`!${dialog}`)
    for (let attempt = 0; attempt < 60 && result()?.status === 'pending'; attempt++) await sleep(150)
    check('user approval is visible to the same MCP agent as applied', closed && result()?.status === 'applied', JSON.stringify(result()))
    check('discarding the newer proposal is visible only as dismissed', result()?.newer === 'dismissed')
    check('the shell-bound agent receives exactly the masked preview', result()?.handoff === preview.text)
    check('saving the replacement asks for fresh execution confirmation', await js(`
      (async () => (${chosen}).mavenMirrors?.[0]?.url === ${JSON.stringify(mirror)} &&
        (await window.electronAPI.runPresetStart(${args})).needsConfirm?.command.includes(${JSON.stringify(mirror)}))()`))
    const problems = await pageProblems(driver)
    check('no console errors or CSP refusals', problems.length === 0, problems.join(' | '))
  } finally {
    if (shellId) await js(`window.electronAPI.localShellClose(${JSON.stringify(shellId)})`).catch(() => {})
    driver.close()
  }
}

run().then(finish).catch(error => { console.error(error); process.exitCode = 1 })
