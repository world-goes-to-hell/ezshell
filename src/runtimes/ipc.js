const { resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { requiredFeature } = require('./required.js')
const { LICENSE_URLS } = require('./providers.js')

const LOCKED = '잠금 해제 후 본창에서 이용할 수 있습니다.'
const reason = (error, fallback) => error?.code ? fallback : error?.message || fallback

function registerRuntimesIpc({ ipcMain, runtimes, canUse, openExternal }) {
  ipcMain.handle('runtimes-list', event => canUse(event)
    ? { jdks: runtimes.list(), hotswapAgent: runtimes.hotswapAgentStatus() }
    : { jdks: [], hotswapAgent: { installed: false } })

  ipcMain.handle('runtimes-available', async (event, vendor, feature) => {
    if (!canUse(event)) return { jdk: null, error: LOCKED }
    try {
      const jdk = await runtimes.available(vendor, feature)
      return canUse(event) ? { jdk } : { jdk: null, error: LOCKED }
    } catch (error) { return { jdk: null, error: reason(error, 'JDK 목록을 받지 못했습니다.') } }
  })

  async function install(event, run, fallback) {
    if (!canUse(event)) return { ok: false, error: LOCKED }
    try {
      const result = await run(progress => {
        if (canUse(event)) event.sender.send('runtimes-progress', progress)
      })
      return canUse(event) ? { ok: true, ...result } : { ok: false, error: LOCKED }
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return { ok: false, cancelled: true }
      return { ok: false, error: reason(error, fallback) }
    }
  }

  ipcMain.handle('runtimes-install', (event, vendor, feature) => install(event,
    async progress => ({ jdk: await runtimes.install(vendor, feature, progress) }), 'JDK를 받지 못했습니다.'))
  ipcMain.handle('runtimes-hotswap-install', event => install(event,
    progress => runtimes.installHotswapAgent(progress), 'HotswapAgent를 받지 못했습니다.'))

  ipcMain.handle('runtimes-cancel', event => Boolean(canUse(event) && runtimes.cancel()))
  ipcMain.handle('runtimes-remove', (event, id) => {
    if (!canUse(event)) return { ok: false, error: LOCKED }
    try { runtimes.remove(id); return { ok: true } }
    catch (error) { return { ok: false, error: reason(error, 'JDK를 지우지 못했습니다. 사용 중인 실행을 닫고 다시 시도하세요.') } }
  })
  ipcMain.handle('runtimes-hotswap-remove', event => {
    if (!canUse(event)) return { ok: false, error: LOCKED }
    try { runtimes.removeHotswapAgent(); return { ok: true } }
    catch (error) { return { ok: false, error: reason(error, 'HotswapAgent를 지우지 못했습니다. 사용 중인 실행을 닫고 다시 시도하세요.') } }
  })

  ipcMain.handle('runtimes-required', async (event, projectFolder) => {
    if (!canUse(event) || typeof projectFolder !== 'string') return { feature: null }
    const resolved = await resolveLocalPreviewPath(projectFolder).catch(() => null)
    if (!resolved?.stat.isDirectory() || !canUse(event)) return { feature: null }
    const feature = await requiredFeature(resolved.path)
    return { feature: canUse(event) ? feature : null }
  })

  ipcMain.handle('runtimes-open-license', async (event, vendor) => {
    if (!canUse(event) || typeof vendor !== 'string' || !Object.hasOwn(LICENSE_URLS, vendor)) return false
    try { await openExternal(LICENSE_URLS[vendor]); return true } catch { return false }
  })
}

module.exports = { registerRuntimesIpc }
