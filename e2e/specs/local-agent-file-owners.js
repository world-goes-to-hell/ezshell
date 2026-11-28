// Which agent changed which uncommitted file (docs/plan/2026-11-28-agent-file-owners.md). Two fake Claudes
// (e2e/support/localAgentFixture.js) open an editing tool through their real hook reporters while the test writes
// a file of the repository; main matches the change to the agent whose tool was open. Checks the "변경" tab:
// - each file row names the agent that changed it, a file both changed shows the overlap
// - the commit box's "에이전트로 고르기" ticks exactly one agent's files
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('node:child_process')
const { connect, createChecks, pageProblems, sleep, unlock, openLocalAgent } = require('../support/driver')

const { check, finish } = createChecks()
const profile = process.env.E2E_PROFILE
const file = name => path.join(profile, name)
const read = name => fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : ''

async function waitFor(test, tries = 160) {
  for (let index = 0; index < tries; index++) {
    const value = await test()
    if (value) return value
    await sleep(75)
  }
  return null
}

async function mcp(agent, name, args = {}) {
  fs.writeFileSync(file(agent + '-mcp-request'), JSON.stringify({ name, arguments: args }))
  const raw = await waitFor(() => read(agent + '-mcp-response') || read(agent + '-mcp-error'))
  if (read(agent + '-mcp-error')) throw new Error(read(agent + '-mcp-error'))
  if (!raw) throw new Error('agent MCP fixture did not finish')
  fs.unlinkSync(file(agent + '-mcp-response'))
  const result = JSON.parse(raw)
  if (result.error || result.isError) throw new Error(result.error || result.content[0].text)
  return JSON.parse(result.content[0].text)
}

const hookLog = agent => read(agent + '-hook-log').split('\n').filter(Boolean).map(line => JSON.parse(line))

/** Fires hook events in the fake agent and waits for their reporters to finish (as local-agent-hooks) */
async function hooks(agent, steps) {
  const before = hookLog(agent).length
  fs.writeFileSync(file(agent + '-hooks'), JSON.stringify(steps))
  const done = await waitFor(() => hookLog(agent).length >= before + steps.length)
  const entries = hookLog(agent).slice(before)
  if (!done) throw new Error('hook reporters did not finish: ' + JSON.stringify(entries))
  const failed = entries.find(entry => entry.error || entry.skipped)
  if (failed) throw new Error(`${agent} ${failed.event}: ${failed.error ?? 'no hook command for it'}`)
  return entries
}

async function run() {
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP local agent fixture needs the Windows development build')
    return
  }
  const driver = await connect()
  const { js, until, click, center, shot } = driver
  try {
    await unlock(driver)
    if (!await js(`typeof window.electronAPI.workspaceFileOwners === 'function'`)) {
      check('main offers the file owners', false, 'window.electronAPI.workspaceFileOwners is missing')
      return
    }
    const repo = path.join(profile, 'owners repo')
    fs.mkdirSync(repo)
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Owners Test', '-c', 'user.email=owners@example.invalid', ...args], { cwd: repo, stdio: 'pipe', windowsHide: true, encoding: 'utf8' })
    git('init', '-b', 'main')
    for (const name of ['a.txt', 'b.txt', 'shared.txt']) fs.writeFileSync(path.join(repo, name), 'first\n')
    git('add', '.')
    git('commit', '-m', 'Start')
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([repo]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    for (const id of ['claude-1', 'claude-2']) {
      await openLocalAgent(driver, 'claude', repo)
      if (!await until(`document.querySelector('[aria-label="${id} 메시지함"]') && document.body.textContent.includes('fixture ready: ${id}')`, 30000)) {
        throw new Error(`${id} did not open: ` + await js(`JSON.stringify({ mail: [...document.querySelectorAll('[aria-label$="메시지함"]')].map(e => e.getAttribute('aria-label')), tabs: [...document.querySelectorAll('.terminal-tab')].map(t => t.textContent), text: document.querySelector('.local-terminal-host')?.innerText?.slice(-300) })`))
      }
      await waitFor(() => read(id + '-tools'))
      await hooks(id, [{ event: 'SessionStart' }, { event: 'UserPromptSubmit', prompt: 'work' }])
    }

    // An agent edits a file: its Edit tool is open while the file changes
    let toolCount = 0
    const edit = async (agent, name) => {
      const tool = `toolu_owner_${++toolCount}`
      await hooks(agent, [{ event: 'PreToolUse', prompt: 'work', tool, toolName: 'Edit' }])
      fs.appendFileSync(path.join(repo, name), `${agent}\n`)
      await sleep(400)
      await hooks(agent, [{ event: 'PostToolUse', prompt: 'work', tool, toolName: 'Edit' }])
      // main matches a change from 1.5s before a tool opens: the next agent's tool must not reach back to this one
      await sleep(2000)
    }
    await edit('claude-1', 'a.txt')
    await edit('claude-2', 'b.txt')
    await edit('claude-1', 'shared.txt')
    await edit('claude-2', 'shared.txt')

    const owners = async () => {
      const answer = await js(`window.electronAPI.workspaceFileOwners(${JSON.stringify(repo)})`)
      return answer?.success ? Object.fromEntries(answer.owners.map(owner => [owner.path, owner.agents.map(agent => agent.id).join(',')])) : answer
    }
    const expected = { 'a.txt': 'claude-1', 'b.txt': 'claude-2', 'shared.txt': 'claude-2,claude-1' }
    check('main matches each change to the agent whose editing tool was open', await waitFor(async () =>
      JSON.stringify(await owners()) === JSON.stringify(expected), 120), JSON.stringify(await owners()))

    await js(`document.querySelector('.workspace-indicator').click()`)
    await until(`!!document.querySelector('#workspace-tab-changes')`)
    await js(`document.querySelector('#workspace-tab-changes').click()`)
    const row = name => `document.querySelector('.workspace-uncommitted .workspace-git-file[data-path="${name}"]')`
    check('each file row names the agent that changed it', await until(`
      ${row('a.txt')}?.querySelector('.workspace-git-owner')?.textContent === 'claude-1' &&
      ${row('b.txt')}?.querySelector('.workspace-git-owner')?.textContent === 'claude-2'
    `, 15000), await js(`[...document.querySelectorAll('.workspace-uncommitted .workspace-git-file')].map(r => r.dataset.path + ':' + (r.querySelector('.workspace-git-owners')?.textContent ?? '-')).join(' | ')`))
    check('a file both agents changed shows the overlap with both names', await until(`
      ${row('shared.txt')}?.querySelector('.workspace-git-overlap')?.textContent === '겹침 2' &&
      ${row('shared.txt')}.querySelector('.workspace-git-owners').title.includes('claude-1') &&
      ${row('shared.txt')}.querySelector('.workspace-git-owners').title.includes('claude-2')
    `))
    await shot('local-agent-file-owners')

    const pickButton = `document.querySelector('.workspace-commit-agents')`
    await click(...await center(pickButton))
    const agentItem = id => `[...document.querySelectorAll('.workspace-commit-agent')].find(item => item.textContent.startsWith(${JSON.stringify(id)}))`
    check('에이전트로 고르기 lists both agents with their files and overlaps', await until(`
      ${agentItem('claude-1')}?.querySelector('.workspace-commit-agent-count')?.textContent === '2개겹침 1' &&
      ${agentItem('claude-2')}?.querySelector('.workspace-commit-agent-count')?.textContent === '2개겹침 1'
    `), await js(`[...document.querySelectorAll('.workspace-commit-agent')].map(item => item.textContent).join(' | ')`))
    await shot('local-agent-file-owners-pick')
    await click(...await center(agentItem('claude-1')))
    const ticked = name => `${row(name)}?.querySelector('.workspace-git-check')?.checked`
    check('picking an agent ticks exactly its files', await until(`
      ${ticked('a.txt')} === true && ${ticked('shared.txt')} === true && ${ticked('b.txt')} === false &&
      document.querySelector('.workspace-commit-button')?.textContent.includes('선택한 2개 파일 커밋')
    `))

    // Freezing (2026-11-28 user decision): nothing is blocked, the other agents of the repository are told to stop
    await mcp('claude-2', 'read_inbox')
    await click(...await center(`document.querySelector('.workspace-freeze-open')`))
    await until(`!!document.querySelector('.workspace-freeze-form select')`)
    await js(`(() => {
      const select = document.querySelector('.workspace-freeze-form select')
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      set.call(select, 'claude-1')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      const input = document.querySelector('.workspace-freeze-form input')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '병합 중')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    check('the freeze form offers both agents of the repository to keep working', await js(`
      [...document.querySelectorAll('.workspace-freeze-form option')].map(option => option.value).join(',') === ',claude-1,claude-2'`))
    await js(`[...document.querySelectorAll('.workspace-freeze-form button')].find(b => b.textContent === '동결하고 알리기').click()`)
    check('frozen, a band names the agent that keeps working and the reason', await until(`
      document.querySelector('.workspace-freeze-band .workspace-freeze-line')?.textContent.startsWith('동결 중 · claude-1만 작업 · 병합 중')`, 5000),
      await js(`document.querySelector('.workspace-changes')?.innerText.slice(0, 300)`))
    await shot('local-agent-file-owners-frozen')
    const frozenInbox = await waitFor(async () => {
      const inbox = await mcp('claude-2', 'read_inbox')
      return inbox.messages?.some(message => message.text.includes('동결했습니다')) ? inbox : null
    }, 60)
    check('the other agent gets the freeze in its inbox as urgent, with the reason', !!frozenInbox?.messages.some(message =>
      message.text.includes('동결했습니다') && message.text.includes('병합 중') && message.urgent === true), JSON.stringify(frozenInbox))
    const keeperInbox = await mcp('claude-1', 'read_inbox')
    check('the agent that keeps working is not told to stop', !keeperInbox.messages?.some(message => message.text.includes('병합 중')), JSON.stringify(keeperInbox))
    await click(...await center(`document.querySelector('.workspace-freeze-thaw')`))
    check('해제 takes the band away at once', await until(`!document.querySelector('.workspace-freeze-band') && !!document.querySelector('.workspace-freeze-open')`, 5000))
    const thawInbox = await waitFor(async () => {
      const inbox = await mcp('claude-2', 'read_inbox')
      return inbox.messages?.some(message => message.text.includes('동결이 풀렸습니다')) ? inbox : null
    }, 60)
    check('the other agent hears the freeze is over', !!thawInbox, JSON.stringify(thawInbox))

    const problems = await pageProblems(driver)
    check('no page errors', !problems.length, JSON.stringify(problems))
  } finally {
    driver.close()
  }
}

run().then(finish).catch(error => { console.error(error); process.exit(1) })
