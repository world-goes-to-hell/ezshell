// The server goes away and stays away: the tab tries five times, then says so and offers 재연결,
// which works once the server is back. Run by e2e/run.js with the test server; its `halt N` word
// drops every connection and refuses new ones for N seconds.
// Slow on purpose: the five tries wait 2, 4, 8, 16 and 30 seconds (about a minute).
const { sleep, createChecks, connect, unlock, connectSsh, PANEL } = require('../support/driver')
const { check, finish } = createChecks()
const DOWN_SECONDS = 75

;(async () => {
  const driver = await connect()
  const { js, until, type, enter, shot } = driver

  const text = () => js(`[...(${PANEL}?.querySelectorAll('.terminal-container[data-pane="main"] .xterm-rows > div') || [])].map(r => r.textContent).join('\\n')`)
  const greetings = async () => ((await text()).match(/fake shell/g) || []).length
  const overlay = () => js(`(() => { const o = ${PANEL}?.querySelector('.connection-lost'); return o ? { detail: o.querySelector('.connection-lost-detail')?.textContent || '', buttons: [...o.querySelectorAll('.connection-lost-btn')].map(b => b.textContent.trim()) } : null })()`)
  const say = async (word) => {
    await js(`${PANEL}.querySelector('.terminal-container[data-pane="main"] .xterm-helper-textarea').focus()`)
    await type(word)
    await enter()
  }

  await unlock(driver)
  check('an SSH tab connects to the test server', await connectSsh(driver))
  await say('BEFORE-HALT')
  await until(`(${PANEL}?.textContent || '').includes('BEFORE-HALT')`, 5000)

  const downAt = Date.now()
  await say(`halt ${DOWN_SECONDS}`)
  check('the lost connection is shown', await until(`!!${PANEL}?.querySelector('.connection-lost')`, 15000))
  check('with automatic tries counted', await until(`/자동으로 다시 연결하는 중입니다 \\(\\d\\/5\\)/.test(${PANEL}?.querySelector('.connection-lost-detail')?.textContent || '')`, 15000), JSON.stringify(await overlay()))
  check('the earlier output stays on screen behind the notice', /BEFORE-HALT/.test(await text()))

  // About a minute: 2 + 4 + 8 + 16 + 30 seconds of waiting between the five tries
  const gaveUp = await until(`/5번 시도했지만 실패/.test(${PANEL}?.querySelector('.connection-lost-detail')?.textContent || '')`, 100000)
  const failed = await overlay()
  check('after five tries the tab says reconnecting failed', gaveUp, JSON.stringify(failed))
  check('and offers 재연결 and 종료', !!failed && failed.buttons.some(b => b.includes('재연결')) && failed.buttons.some(b => b.includes('종료')), JSON.stringify(failed?.buttons))
  check('the tab is still there', (await js(`document.querySelectorAll('.terminal-tab').length`)) === 1)
  await shot('ssh-reconnect-fail-1-gave-up')

  // The server comes back; then 재연결 works
  const wait = DOWN_SECONDS * 1000 - (Date.now() - downAt) + 3000
  if (wait > 0) await sleep(wait)
  const before = await greetings()
  await js(`[...(${PANEL}?.querySelectorAll('.connection-lost-btn') || [])].find(b => b.textContent.includes('재연결'))?.click()`)
  check('재연결 brings the tab back once the server is up', await until(`!${PANEL}?.querySelector('.connection-lost')`, 30000), JSON.stringify(await overlay()))
  check('with a new shell', await (async () => { const start = Date.now(); while (Date.now() - start < 15000) { if ((await greetings()) > before) return true; await sleep(300) } return false })(), (await text()).trim().slice(-160))
  await sleep(800)
  await say('AFTER-COMEBACK')
  check('which answers', await until(`(${PANEL}?.textContent || '').includes('AFTER-COMEBACK')`, 8000))

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
