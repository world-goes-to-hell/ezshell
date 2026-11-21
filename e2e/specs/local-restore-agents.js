// Local tabs opened again after a restart resume the agent conversations of their panes
// (lib/restoreAgents.ts). The fake transcripts and the recorded shell starts come from
// e2e/support/agentHistoryApp.js; the record is saved directly, as the app does when it closes.
const fs = require('fs')
const path = require('path')
const { connect, createChecks, unlock, sleep } = require('../support/driver')

const { check, finish } = createChecks()
const CLAUDE_ID = 'abcdef12-1111-4222-8333-444455556666'
const CODEX_ID = '01a1ec18-9b8a-71c1-839d-2e31c010300f'

;(async () => {
  const driver = await connect()
  const { js, until, send } = driver
  const profile = process.env.E2E_PROFILE
  const spawned = path.join(profile, 'spawned.jsonl')
  const launches = () => (fs.existsSync(spawned) ? fs.readFileSync(spawned, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])

  await unlock(driver)
  const record = {
    version: 1,
    tabs: [...Array.from({ length: 10 }, (_, index) => ({ kind: 'local', title: `로컬 복원 ${index + 1}`, cwd: path.join(profile, 'work app') })), {
      kind: 'local', title: 'gsd · 작업', cwd: path.join(profile, 'work app'), workspaceLabel: 'work app',
      splitTree: { kind: 'split', axis: 'row', ratio: 0.5, first: { kind: 'pane', pane: 'main' }, second: { kind: 'split', axis: 'col', ratio: 0.5, first: { kind: 'pane', pane: 'split-1' }, second: { kind: 'pane', pane: 'split-2' } } }, paneSeq: 2,
      // split-2: an agent that was never talked to (no session to resume): it starts again fresh
      agents: [{ pane: 'main', agent: 'claude', sessionId: CLAUDE_ID }, { pane: 'split-1', agent: 'codex', sessionId: CODEX_ID }, { pane: 'split-2', agent: 'codex' }]
    }]
  }
  const saved = await js(`window.electronAPI.restoreTabsSave(${JSON.stringify(record)})`)
  check('the record with the panes\' agents is saved', saved?.success === true, JSON.stringify(saved))

  await send('Page.reload')
  await sleep(1500)
  await unlock(driver)
  check('after unlocking, the notice offers the tab again', await until(`!!document.querySelector('.restore-tabs-banner')`, 15000))
  const before = launches().length
  await js(`[...document.querySelectorAll('.restore-tabs-btn')].find(b => b.textContent.includes('다시 열기')).click()`)
  check('eleven local tabs reopen with all thirteen shells', await until(`
    document.querySelectorAll('.terminal-tab').length === 11 && document.querySelectorAll('.local-terminal-pane[data-local-shell-id]').length === 13
  `, 45000))

  const fresh = launches().slice(before)
  const claude = fresh.find(launch => launch.args.join(' ').includes(`--resume ${CLAUDE_ID}`))
  const codex = fresh.find(launch => launch.args.join(' ').includes(`resume ${CODEX_ID}`) && !launch.args.join(' ').includes('--resume'))
  check('the main pane resumes its Claude conversation in its folder', !!claude && path.normalize(claude.cwd) === path.join(profile, 'work app'), claude?.cwd)
  check('the other pane resumes its Codex conversation in the folder of that session', !!codex && path.normalize(codex.cwd) === path.join(profile, 'other folder'), codex?.cwd)
  const freshCodex = fresh.filter(({ args }) => args.some(arg => arg.includes('mcp_servers.ezshell-cli-mcp.command=')) && !args.join(' ').includes(' resume '))
  check('the pane whose agent had no conversation starts the same agent fresh', freshCodex.length === 1, String(freshCodex.length))
  check('the split tab keeps its recorded title', await js(`[...document.querySelectorAll('.terminal-tab')].some(tab => tab.textContent.includes('gsd · 작업'))`))

  finish()
})().catch(error => { console.error(error); process.exit(1) })
