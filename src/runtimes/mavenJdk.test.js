import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { planMavenJdk } from './mavenJdk.js'

let root
const binary = name => process.platform === 'win32' ? `${name}.exe` : name
beforeEach(async () => { root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ezshell-maven-jdk-')) })
afterEach(async () => fs.rm(root, { recursive: true, force: true }))

async function jdk(name, version) {
  const home = path.join(root, name)
  await fs.mkdir(path.join(home, 'bin'), { recursive: true })
  await Promise.all(['java', 'javac'].map(name => fs.writeFile(path.join(home, 'bin', binary(name)), 'fixture')))
  await fs.writeFile(path.join(home, 'release'), `JAVA_VERSION="${version}"\nOS_ARCH="amd64"\n`)
  return home
}

describe('Maven execution JDK', () => {
  it('chooses a managed runtime for Maven and uses the project JDK to compile and test', async () => {
    const projectJdkHome = await jdk('Project JDK', '1.8.0_281')
    const zulu = await jdk('Managed Zulu', '17.0.15')
    const temurin = await jdk('Managed Temurin', '21.0.5+11')
    const runtimes = [{ id: 'temurin', feature: 21, managed: true }, { id: 'zulu', feature: 17, managed: true }]
    const paths = { zulu, temurin }
    const env = { JAVA_HOME: projectJdkHome, JAVACMD: 'old', PATH: 'previous' }
    const input = { projectJdkHome, jdks: runtimes, javaHomeOf: id => paths[id], env }
    const plan = await planMavenJdk(input)
    expect(plan.mavenJdk).toEqual({ id: 'zulu', home: zulu, feature: 17 })
    expect(plan.projectJdk).toEqual({ home: projectJdkHome, feature: 8 })
    expect(plan.env).toEqual({ JAVA_HOME: zulu, PATH: `${path.join(zulu, 'bin')}${path.delimiter}previous` })
    expect(env.JAVA_HOME).toBe(projectJdkHome)
    expect(plan.args).toEqual(['-Dmaven.compiler.fork=true', `-Dmaven.compiler.executable=${path.join(projectJdkHome, 'bin', binary('javac'))}`,
      `-Djvm=${path.join(projectJdkHome, 'bin', binary('java'))}`])
    expect((await planMavenJdk({ ...input, mavenJdkId: 'temurin' })).mavenJdk.feature).toBe(21)
  })

  it('rejects unusable projects and uses the next installed managed runtime when one disappears', async () => {
    const old = await jdk('Old', '1.8.0_281')
    const modern = await jdk('Current', '21.0.5+11')
    const jdks = [{ id: 'gone', feature: 17, managed: true }, { id: 'current', feature: 21, managed: true }]
    const input = { projectJdkHome: old, jdks, javaHomeOf: id => id === 'current' ? modern : null }
    expect((await planMavenJdk(input)).mavenJdk.id).toBe('current')
    await expect(planMavenJdk({ ...input, projectJdkHome: path.join(root, 'missing') })).rejects.toThrow('프로젝트 JDK')
    await expect(planMavenJdk({ ...input, jdks: [{ id: 'current', feature: 21, managed: false }] })).rejects.toThrow('JDK 17 또는 21')
  })

  it('accepts a legacy project JDK with java and javac before release manifests existed', async () => {
    const old = await jdk('Legacy', '1.6.0_45')
    const runtime = await jdk('Managed', '17.0.15')
    await fs.unlink(path.join(old, 'release'))
    const plan = await planMavenJdk({ projectJdkHome: old, jdks: [{ id: 'managed', feature: 17, managed: true }], javaHomeOf: () => runtime })
    expect(plan.projectJdk).toEqual({ home: old, feature: null })
  })
})
