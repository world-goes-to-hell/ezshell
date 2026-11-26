const fs = require('node:fs/promises')
const path = require('node:path')
const { isLocalFilePath } = require('../localKeyPath.js')
const { planMavenJdk } = require('../runtimes/mavenJdk.js')
const { readRelease } = require('../runtimes/discovery.js')
const { createMavenPinSession } = require('../runtimes/mavenPin.js')
const { appendMavenSettings, prepareMavenSettings, SPRING_BOOT_MAVEN_JVM } = require('./runSuggestions.js')

const envValue = (env, key) => Object.entries(env ?? {}).find(([name]) => process.platform === 'win32'
  ? name.toUpperCase() === key : name === key)?.[1]

async function projectJavaHome(task) {
  const home = task.javaHome ?? envValue(task.env, 'JAVA_HOME') ?? envValue(process.env, 'JAVA_HOME')
  if (home) return home
  const search = envValue(task.env, 'PATH') ?? envValue(process.env, 'PATH') ?? ''
  for (const directory of search.split(path.delimiter)) {
    const folder = directory.replace(/^"|"$/g, '')
    if (!isLocalFilePath(folder)) continue
    const candidate = path.join(folder, 'java' + (process.platform === 'win32' ? '.exe' : ''))
    const real = await fs.realpath(candidate).catch(() => null)
    if (isLocalFilePath(real) && (await fs.stat(real).catch(() => null))?.isFile()) return path.dirname(path.dirname(real))
  }
  return undefined
}

async function prepareMavenRun(task, preset, { userData, listJdks, javaHomeOf, javaVersion, mavenVersion, platform }) {
  const home = await projectJavaHome(task)
  const feature = (isLocalFilePath(home) && readRelease(home, process.platform)?.feature) || await javaVersion(task.javaHome, task.env, task.cwd)
  const springBoot = preset.kind === 'task'
  const useManaged = preset.mavenRunner || (feature && feature < 17 && (!springBoot || preset.mavenSplit === true))
  const plan = await planMavenJdk({ projectJdkHome: home, projectFeature: feature, jdks: useManaged ? await listJdks() : [], javaHomeOf,
    mavenJdkId: preset.mavenRunner, split: preset.mavenSplit ?? (springBoot ? false : 'auto'), allowMissingRunner: true, platform })
  const differentRuntime = plan.mavenJdk && (!home || path.relative(home, plan.mavenJdk.home) !== '')
  if (springBoot && differentRuntime && preset.hotReload === 'enhanced') {
    throw new Error('확장 바로 반영에는 구성과 같은 JetBrains Runtime이 필요합니다. Maven 실행 JDK를 자동 또는 구성과 같은 JDK로 선택해 주세요.')
  }
  const pinned = preset.mavenSource === 'pinned'
  const online = pinned ? { args: [] } : prepareMavenSettings(preset, { userData, mavenVersion })
  let session
  try {
    if (pinned || preset.mavenPin) session = await createMavenPinSession({ userData, presetId: preset.id, mode: pinned ? 'replay' : 'capture' })
    const args = [...plan.args, ...online.args, ...(session?.args ?? [])]
    return { ...task, command: appendMavenSettings(task.command, args, platform),
      ...(plan.mavenJdk && { javaHome: plan.mavenJdk.home, clearJavaCommand: true }),
      ...(plan.projectJdk && { projectJavaHome: plan.projectJdk.home }),
      ...(springBoot && differentRuntime && { launchNotice: `[WARN] ${SPRING_BOOT_MAVEN_JVM}` }),
      mavenFeature: plan.mavenJdk?.feature ?? feature,
      cleanup: async (exitCode, signal) => {
        try { await session?.finish(exitCode, signal) }
        catch { if (!signal?.aborted) console.warn('[Maven] 실행의 의존성을 보관하거나 임시 폴더를 정리하지 못했습니다.') }
        finally { await online.cleanup?.() }
      } }
  } catch (error) {
    try { await session?.finish(null) } finally { await online.cleanup?.() }
    throw error
  }
}

module.exports = { prepareMavenRun }
