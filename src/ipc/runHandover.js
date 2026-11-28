// A run preset server handed from an app restarting for an update to the next app
// (docs/plan/2026-11-27-run-presets-survive-update.md). The server keeps running in the session host. The old app
// describes the run (describeHandover); the new app reads that description as data (handedRun) and builds the
// run's task again from the saved preset (adoptedTask). Nothing in the description grants anything by itself:
// runPresets.adoptRun checks the project, the preset and its folder before the run is taken back.
const path = require('node:path')
const { portFilter } = require('./hotReload.js')

const HANDED = new Set(['starting', 'running'])
const LOOPBACK = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}(?:\/\S{0,200})?$/
const PRESET_ID = /^[\w-]{1,100}$/
const TOMCAT_RELOAD_AFTER_UPDATE = '업데이트 뒤에는 Tomcat 바로 반영을 이어 쓸 수 없습니다. 재기동하면 다시 켜집니다.'

/** What the next app needs to take this run back, or null when it is not a server that is starting or running */
function describeHandover(run, task, pid = process.pid) {
  if (!HANDED.has(run.state.status) || !run.state.shellId) return null
  const reload = task.hotReload
  // A Tomcat reload works on a layout of paths (classes, sources, classpath) the next app cannot check again
  const keepsReload = Boolean(reload) && !reload.layout
  return {
    projectRoot: run.project.root, worktree: run.project.worktree, presetId: run.id,
    startedAt: run.state.startedAt ?? null, readyAt: run.state.readyAt ?? null, address: run.state.address ?? null,
    expectedUrl: typeof task.expectedUrl === 'string' ? task.expectedUrl : null,
    // Its scratch (Tomcat base, Maven settings, eclipse classes) is named after the app that started it
    scratchOwner: task.scratchOwner ?? pid,
    tomcat: task.tomcat === true,
    hotReload: keepsReload ? { port: Number.isInteger(reload.port) ? reload.port : null, devtools: reload.devtools === true } : null,
    hotReloadDropped: Boolean(reload?.layout)
  }
}

const time = value => Number.isSafeInteger(value) && value > 0 ? value : undefined
const loopback = value => typeof value === 'string' && LOOPBACK.test(value) ? value : undefined
const port = value => Number.isInteger(value) && value > 0 && value < 65536 ? value : null
const absolute = value => typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !value.includes('\0')

/** The description from the session host, checked for shape only; throws when it cannot be a run */
function handedRun(development) {
  const run = development?.run
  if (!run || typeof run !== 'object' || typeof development.taskId !== 'string' || !absolute(development.cwd)
    || !absolute(run.projectRoot) || !absolute(run.worktree) || typeof run.presetId !== 'string' || !PRESET_ID.test(run.presetId)) {
    throw new Error('넘겨받은 실행 정보가 올바르지 않습니다.')
  }
  const reload = run.hotReload && typeof run.hotReload === 'object'
    ? { port: port(run.hotReload.port), devtools: run.hotReload.devtools === true } : null
  return {
    projectRoot: run.projectRoot, worktree: run.worktree, presetId: run.presetId,
    startedAt: time(run.startedAt), readyAt: time(run.readyAt), address: loopback(run.address), expectedUrl: loopback(run.expectedUrl),
    scratchOwner: Number.isSafeInteger(run.scratchOwner) && run.scratchOwner > 0 ? run.scratchOwner : 0,
    tomcat: run.tomcat === true,
    // Hot reload goes on only on the JDWP port it was given (or with devtools, which has none)
    hotReload: reload && (reload.port || reload.devtools) ? reload : null,
    hotReloadDropped: run.hotReloadDropped === true
  }
}

/** The task for the taken-back run, from the saved preset; `cleanup` runs when the server ends */
function adoptedTask(handed, { preset, cwd, worktree, javaHome, cleanup }) {
  const reload = handed.hotReload && preset.hotReload && preset.hotReload !== 'off'
    ? { ...(handed.hotReload.port && { port: handed.hotReload.port }), ...(handed.hotReload.devtools && { devtools: true }),
      worktree, cwd, mode: preset.hotReload }
    : undefined
  return {
    id: `preset:${preset.id}`, relative: preset.relative, name: preset.name, label: preset.name, cwd,
    javaHome, env: preset.env, logEncoding: preset.logEncoding, tomcat: handed.tomcat,
    ...(handed.expectedUrl && { expectedUrl: handed.expectedUrl }),
    scratchOwner: handed.scratchOwner || undefined,
    ...(reload && { hotReload: reload, ...(reload.port && { filterOutput: portFilter(reload.port) }) }),
    ...(handed.hotReloadDropped && { hotReloadFailure: TOMCAT_RELOAD_AFTER_UPDATE }),
    cleanup
  }
}

module.exports = { describeHandover, handedRun, adoptedTask, TOMCAT_RELOAD_AFTER_UPDATE }
