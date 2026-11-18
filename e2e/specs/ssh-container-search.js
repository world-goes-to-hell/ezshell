// The container panel's name search: several words match any of them, the matching containers go to
// the top and are marked, and every other container (running ones included) stays in the list.
// The test server answers `docker ps` with five running containers and one stopped (with -a).
// Run by e2e/run.js, which starts e2e/support/sshd.js for specs named ssh-*.
const { sleep, createChecks, connect, unlock, connectSsh } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, until, shot } = driver
  const SET = `(el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }`
  const names = () => js(`[...document.querySelectorAll('.container-panel .container-row')].map(r => r.querySelector('.container-name').textContent)`)
  const marked = () => js(`[...document.querySelectorAll('.container-panel .container-row.is-match')].map(r => r.querySelector('.container-name').textContent)`)
  const search = async (value) => { await js(`(${SET})(document.querySelector('.container-search input'), ${JSON.stringify(value)})`); await sleep(300) }

  await unlock(driver)
  check('an SSH tab connects', await connectSsh(driver))
  await js(`document.querySelector('[title^="도커 컨테이너"]').click()`)
  check('the panel lists the containers', await until(`document.querySelectorAll('.container-panel .container-row').length === 5`, 10000), JSON.stringify(await names()))
  const before = await names()

  await search('redis, NGINX')
  check('containers matching either word come first', JSON.stringify(await names()) === JSON.stringify(['web-nginx', 'cache-redis', 'nginx-proxy', 'api-server', 'db-main']), JSON.stringify(await names()))
  check('and are marked', JSON.stringify(await marked()) === JSON.stringify(['web-nginx', 'cache-redis', 'nginx-proxy']), JSON.stringify(await marked()))
  check('the matching letters are marked in the names', JSON.stringify(await js(`[...document.querySelectorAll('.container-name-mark')].map(m => m.textContent)`)) === JSON.stringify(['nginx', 'redis', 'nginx']))
  check('the running containers that do not match are still shown', (await names()).includes('api-server') && (await names()).includes('db-main'))
  check('the count says how many matched', /3개 일치/.test(await js(`document.querySelector('.container-search-count')?.textContent || ''`)))
  await shot('ssh-container-search-1')

  await search('zzz')
  check('with no match every container is still listed, with a note', (await names()).length === 5 && /일치하는 컨테이너가 없습니다/.test(await js(`document.querySelector('.container-panel').textContent`)))

  await search('redis')
  await js(`[...document.querySelectorAll('.container-option')].find(l => l.textContent.includes('중지된 것도'))?.querySelector('input').click()`)
  check('with stopped containers shown, a stopped match joins the top', await until(`[...document.querySelectorAll('.container-panel .container-row.is-match')].map(r => r.querySelector('.container-name').textContent).join() === 'cache-redis,old-redis-job'`, 10000), JSON.stringify(await marked()))

  await js(`document.querySelector('.container-search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(300)
  check('Esc clears the search and the usual order comes back', (await js(`document.querySelector('.container-search input').value`)) === '' && (await marked()).length === 0 && JSON.stringify((await names()).slice(0, 5)) === JSON.stringify(before), JSON.stringify(await names()))

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
