// Local work card colours (docs/plan/2026-11-27-local-project-colors.md): automatic colours from the palette
// in sidebar order, a colour picked for one project from its menu, and the shared schemes.
const fs = require('fs')
const path = require('path')
const { connect, createChecks, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const PALETTE = [250, 165, 35]

async function run() {
  const folders = ['alpha', 'beta', 'gamma'].map(name => path.join(process.env.E2E_PROFILE, `colour ${name}`))
  for (const folder of folders) fs.mkdirSync(folder)
  const driver = await connect()
  try {
    const { js, until } = driver
    await unlock(driver)
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify(folders))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    const hues = `[...document.querySelectorAll('.local-project')].map(card => Number(card.style.getPropertyValue('--local-project-hue')))`
    const huesAre = expected => until(`JSON.stringify(${hues}) === ${JSON.stringify(JSON.stringify(expected))}`, 10000)
    check('three cards take the first three palette colours in order', await huesAre(PALETTE), JSON.stringify(await js(hues)))

    const dialog = `document.querySelector('.project-color-dialog')`
    await js(`document.querySelectorAll('.local-project-head')[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 120 }))`)
    const menuItem = `[...document.querySelectorAll('button, [role="menuitem"]')].find(item => item.textContent.trim() === '색상…')`
    check('the project menu offers a colour', await until(`!!${menuItem}`, 5000))
    await js(`${menuItem}.click()`)
    check('the colour dialog opens for that project', await until(`${dialog}?.querySelector('.project-color-preview')?.textContent === 'colour beta'
      && ${dialog}.querySelector('.project-color-state').textContent === '자동'`, 5000))

    await js(`${dialog}.querySelector('.project-color-swatch[aria-label="장미"]').click()`)
    check('a picked colour shows on its card at once and is kept', await huesAre([250, 350, 165]) &&
      JSON.parse(await js(`localStorage.getItem('ezshell.localProjectColors')`)).manual &&
      await until(`${dialog}.querySelector('.project-color-state').textContent === '직접 고른 색'`))

    const scheme = value => js(`${dialog}.querySelector('[data-scheme="${value}"] input').click()`)
    await scheme('uniform')
    check('all the same colour keeps only the picked one apart', await huesAre([250, 350, 250]))
    await js(`[...${dialog}.querySelectorAll('.project-color-base .project-color-swatch')].find(item => item.getAttribute('aria-label') === '초록').click()`)
    check('the base colour applies to every automatic card', await huesAre([140, 350, 140]))
    await driver.shot('local-project-colors-dialog')

    await scheme('analogous')
    check('a similar range stays near the base colour', await huesAre([95, 350, 185]))

    await js(`[...${dialog}.querySelectorAll('button')].find(item => item.textContent.startsWith('직접 고른 색 모두 지우기')).click()`)
    await scheme('harmony')
    check('clearing picks and going back to the palette restores the first colours', await huesAre(PALETTE))
    await js(`${dialog}.querySelector('.modal-actions button').click()`)
    check('the dialog closes', await until(`!${dialog}`, 5000))
  } finally {
    driver.close()
  }
}

run().then(finish).catch(error => {
  console.error(error)
  process.exitCode = 1
})
