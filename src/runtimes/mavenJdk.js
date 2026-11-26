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

/** The private runtime list supplies managed JDK IDs. Return literal Maven argv tokens for the caller's launcher. */
async function planMavenJdk({ projectJdkHome, jdks, javaHomeOf, mavenJdkId, env = {}, platform = process.platform }) {
  const project = await jdkHome(projectJdkHome, platform)
  if (!project) throw new Error('컴파일과 테스트에 사용할 프로젝트 JDK를 찾을 수 없습니다.')
  const managed = jdks.filter(jdk => jdk.managed && RUNTIME_ORDER.includes(jdk.feature) && (!mavenJdkId || jdk.id === mavenJdkId))
    .sort((a, b) => RUNTIME_ORDER.indexOf(a.feature) - RUNTIME_ORDER.indexOf(b.feature))
  for (const candidate of managed) {
    const runtime = await jdkHome(await javaHomeOf(candidate.id), platform)
    if (runtime?.feature !== candidate.feature) continue
    return {
      mavenJdk: { id: candidate.id, home: runtime.home, feature: runtime.feature },
      projectJdk: project,
      env: launchEnvironment(env, runtime.home, platform),
      args: [
        '-Dmaven.compiler.fork=true',
        `-Dmaven.compiler.executable=${javaExecutable(project.home, 'javac', platform)}`,
        `-Djvm=${javaExecutable(project.home, 'java', platform)}`
      ]
    }
  }
  throw new Error('개발 도구에서 Maven 실행에 사용할 JDK 17 또는 21을 받아 주세요.')
}

module.exports = { planMavenJdk }
