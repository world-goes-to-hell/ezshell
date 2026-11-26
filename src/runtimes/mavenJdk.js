const path = require('node:path')
const { resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { sameOrInside } = require('../localFiles/roots.js')
const { readRelease } = require('./discovery.js')

const RUNTIME_ORDER = [17, 21]
const javaExecutable = (home, name, platform) => path.join(home, 'bin', platform === 'win32' ? `${name}.exe` : name)

async function jdkHome(home, platform) {
  if (typeof home !== 'string') return null
  const entry = await resolveLocalPreviewPath(home).catch(() => null)
  if (!entry?.stat.isDirectory()) return null
  const binaries = await Promise.all(['java', 'javac'].map(name => {
    const file = javaExecutable(entry.path, name, platform)
    return resolveLocalPreviewPath(file).catch(() => null).then(binary => binary?.stat.isFile() && sameOrInside(entry.path, binary.path))
  }))
  if (!binaries.every(Boolean)) return null
  return { home: entry.path, feature: readRelease(entry.path, platform)?.feature ?? null }
}

function launchEnvironment(env, home, platform) {
  const options = { ...env }
  const key = name => platform === 'win32' ? Object.keys(options).find(item => item.toUpperCase() === name) ?? name : name
  const pathName = key('PATH')
  delete options[key('JAVACMD')]
  options[key('JAVA_HOME')] = home
  options[pathName] = [path.join(home, 'bin'), options[pathName]].filter(Boolean).join(path.delimiter)
  return options
}

async function selectMavenJdk({ jdks, javaHomeOf, mavenJdkId, platform = process.platform }) {
  const managed = jdks.filter(jdk => jdk.managed && RUNTIME_ORDER.includes(jdk.feature) && (!mavenJdkId || jdk.id === mavenJdkId))
    .sort((a, b) => RUNTIME_ORDER.indexOf(a.feature) - RUNTIME_ORDER.indexOf(b.feature))
  for (const candidate of managed) {
    const runtime = await jdkHome(await javaHomeOf(candidate.id), platform)
    if (runtime?.feature === candidate.feature) return { id: candidate.id, ...runtime }
  }
  return null
}

/** Return literal Maven argv tokens for the caller's launcher. */
async function planMavenJdk({ projectJdkHome, jdks, javaHomeOf, mavenJdkId, env = {}, platform = process.platform,
  split = true, projectFeature, allowMissingRunner = false }) {
  const mavenJdk = await selectMavenJdk({ jdks, javaHomeOf, mavenJdkId, platform })
  if (!mavenJdk && (mavenJdkId || !allowMissingRunner)) throw new Error('개발 도구에서 Maven 실행에 사용할 JDK 17 또는 21을 받아 주세요.')
  const useProjectJdk = split === 'auto' ? Boolean(mavenJdk && projectFeature && projectFeature < 17) : split
  const projectJdk = useProjectJdk ? await jdkHome(projectJdkHome, platform) : null
  if (useProjectJdk && !projectJdk) throw new Error('컴파일과 테스트에 사용할 프로젝트 JDK를 찾을 수 없습니다.')
  return {
    mavenJdk,
    projectJdk,
    env: mavenJdk ? launchEnvironment(env, mavenJdk.home, platform) : env,
    args: projectJdk ? [
      '-Dmaven.compiler.fork=true',
      `-Dmaven.compiler.executable=${javaExecutable(projectJdk.home, 'javac', platform)}`,
      `-Djvm=${javaExecutable(projectJdk.home, 'java', platform)}`
    ] : []
  }
}

module.exports = { planMavenJdk, selectMavenJdk }
