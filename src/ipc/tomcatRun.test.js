import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { antTargets, catalinaOptions, closeTomcatBases, planTomcat, stageTomcat, tomcatLayout, webappCandidates } from './tomcatRun.js'
import { prepareTomcatReload } from './hotReload.js'
import { validatePreset, presetApproval } from './runPresetStore.js'
import { parseXml } from '../sessionImport/filezilla.js'

const id = '12d8051b-e41a-42f7-98ad-b4673eaa2c1b'
const original = `<?xml version="1.0" encoding="UTF-8"?>
<Server port="8005" portOffset="200" shutdown="STOP"><Listener className="listener"/>
  <Service name="Catalina"><Connector port="8080" protocol="HTTP/1.1"/>
    <Connector port="8009" protocol="AJP/1.3"/><Connector port="8443" protocol="org.apache.coyote.http11.Http11NioProtocol" SSLEnabled="true"/>
    <Engine name="Catalina" defaultHost="localhost"><Host name="localhost" appBase="webapps" autoDeploy="true" deployOnStartup="true">
      <Context path="/unrelated" docBase="elsewhere"/><Valve className="valve" pattern="&quot;long &amp; safe&quot;"/>
    </Host></Engine>
  </Service>
</Server>`
let root, project, home, profile, web, cleanups
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ezshell-tomcat-unit-'))
  project = path.join(root, 'project')
  home = path.join(root, 'Tomcat home')
  profile = path.join(root, 'profile')
  web = path.join(project, 'Web & Pages')
  cleanups = []
  await Promise.all([fs.mkdir(path.join(web, 'WEB-INF'), { recursive: true }), fs.mkdir(path.join(home, 'bin'), { recursive: true }),
    fs.mkdir(path.join(home, 'conf', 'Catalina', 'localhost'), { recursive: true }), fs.mkdir(profile)])
  await Promise.all([fs.writeFile(path.join(home, 'bin', 'catalina.bat'), 'fixture'), fs.writeFile(path.join(home, 'bin', 'catalina.sh'), 'fixture'),
    fs.writeFile(path.join(home, 'conf', 'server.xml'), original), fs.writeFile(path.join(home, 'conf', 'web.xml'), '<web-app/>'),
    fs.writeFile(path.join(home, 'conf', 'Catalina', 'localhost', 'unrelated.xml'), '<Context/>')])
})
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(root, { recursive: true, force: true })
})

const preset = fields => validatePreset({ name: 'Web app', kind: 'tomcat', tomcat: 'tomcat-9.0.1', webapp: 'Web & Pages', ...fields }, id)
const launch = (preset, platform = process.platform, toolHomeFor = () => null) =>
  planTomcat(preset, project, { toolHomeOf: () => home, toolHomeFor, platform })
async function stage(plan, preset) {
  const task = await stageTomcat(plan, { preset, task: { cwd: project, env: { EXISTING: 'yes' }, javaHome: home }, worktree: project,
    userData: profile, prepareReload: options => prepareTomcatReload({ ...options, reserve: async () => 59998 }) })
  cleanups.push(task.cleanup)
  return task
}

describe('Tomcat execution presets', () => {
  it('validates the webapp path, context, port, compiler settings and build tokens', () => {
    expect(preset()).toMatchObject({ contextPath: '/', port: 8080, vmArgs: '', hotReload: 'off', webapp: 'Web & Pages' })
    expect(preset({ contextPath: '/한글', hotReload: 'standard', prepare: { tool: 'maven', goals: ' clean\tpackage  ' } }))
      .toMatchObject({ contextPath: '/한글', hotReload: 'standard', prepare: { tool: 'maven', goals: 'clean package' } })
    for (const bad of [{ webapp: '../escape' }, { webapp: '//network' }, { webapp: '' }, { contextPath: '/ROOT' }, { contextPath: '/a/b' },
      { port: 0 }, { port: '8080' }, { vmArgs: 'broken' }, { vmArgs: '-Dvalue="unterminated' }, { vmArgs: '-Xmx512m\n-Xms256m' },
      { prepare: { tool: 'maven', goals: 'clean && shell' } }, { prepare: { tool: 'maven', goals: '-Doption' } }, { prepare: { tool: 'ant', target: '-f' } },
      { hotReload: 'enhanced', vmArgs: '-Xrunjdwp:server=y' }]) expect(() => preset(bad)).toThrow()
  })

  it('ties confirmation to the VM arguments and build text', () => {
    expect(presetApproval(preset())).toBeNull()
    const approved = preset({ vmArgs: '-Xmx512m', prepare: { tool: 'maven', goals: 'package' } })
    expect(presetApproval(approved)).toMatchObject({ command: '기동 전 빌드\nmaven package\n\nTomcat VM 인자\n-Xmx512m' })
    expect(presetApproval({ ...approved, vmArgs: '-Xmx1024m' }).hash).not.toBe(presetApproval(approved).hash)
    expect(presetApproval({ ...approved, prepare: { tool: 'maven', goals: 'clean package' } }).hash).not.toBe(presetApproval(approved).hash)
    expect(presetApproval({ ...approved, port: 9090 }).hash).toBe(presetApproval(approved).hash)
  })

  it('rechecks Ant targets and builds a command only from registered tool paths and safe goal tokens', async () => {
    await fs.writeFile(path.join(project, 'build.xml'), '<project><target name="package"/><target name="deploy &amp; stop"/></project>')
    expect(await antTargets(project)).toEqual(['package'])
    const ant = path.join(root, 'Ant tools')
    await fs.mkdir(path.join(ant, 'bin'), { recursive: true })
    await fs.writeFile(path.join(ant, 'bin', 'ant.bat'), 'fixture')
    const p = preset({ prepare: { tool: 'ant', target: 'package' } })
    expect(await launch(p, 'win32', () => ant)).toMatchObject({ prepareCommand: `& '${path.join(ant, 'bin', 'ant.bat')}' package` })
    await fs.writeFile(path.join(project, 'build.xml'), '<project><target name="clean"/></project>')
    await expect(launch(p, 'win32')).rejects.toThrow('Ant 타깃')
    const m = preset({ prepare: { tool: 'maven', goals: 'clean package' } })
    expect(await launch(m, 'linux')).toMatchObject({ prepareCommand: "'mvn' clean package" })
    expect(await launch(m, 'win32')).toMatchObject({ prepareCommand: "& 'mvn' clean package" })
  })

  it('creates a separate Catalina base for each run without changing the installation', async () => {
    const p = preset({ port: 8890, contextPath: '/hello', vmArgs: '-Dfoo="with spaces"' })
    const plan = await launch(p, 'win32')
    const first = await stage(plan, p)
    const parent = path.dirname(first.env.CATALINA_BASE)
    const old = path.join(parent, 'run-ABC123')
    await fs.mkdir(old)
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    await fs.utimes(old, twoDaysAgo, twoDaysAgo)
    const second = await stage(plan, p)
    await expect(fs.stat(old)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.stat(first.env.CATALINA_BASE)).isDirectory()).toBe(true)
    expect(first.command).toBe(`[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n& '${path.join(home, 'bin', 'catalina.bat')}' run`)
    expect(first.env).toMatchObject({ EXISTING: 'yes', CATALINA_HOME: home, CATALINA_OPTS: '"-Dfoo=with spaces"', JRE_HOME: home })
    expect(first.expectedUrl).toBe('http://127.0.0.1:8890/hello')
    const base = first.env.CATALINA_BASE
    expect(path.dirname(base)).toBe(path.join(profile, 'runtimes', 'tomcat-base', p.id))
    expect(base).not.toBe(second.env.CATALINA_BASE)
    expect(await fs.readFile(path.join(home, 'conf', 'server.xml'), 'utf8')).toBe(original)
    const xml = await fs.readFile(path.join(base, 'conf', 'server.xml'), 'utf8')
    expect(xml).toContain('Web &amp; Pages')
    const node = parseXml(xml)
    expect(node.attrs).toMatchObject({ port: '-1', shutdown: 'STOP' })
    expect(node.attrs).not.toHaveProperty('portOffset')
    const service = node.children.find(item => item.name === 'Service')
    expect(service.children.filter(item => item.name === 'Connector').map(item => item.attrs)).toEqual([
      { port: '8890', protocol: 'HTTP/1.1', address: '127.0.0.1', scheme: 'http', secure: 'false' }
    ])
    const host = service.children.find(item => item.name === 'Engine').children.find(item => item.name === 'Host')
    expect(host.attrs).toMatchObject({ autoDeploy: 'false', deployOnStartup: 'false', appBase: 'apps' })
    expect(host.children.filter(item => item.name === 'Context').map(item => item.attrs)).toEqual([{ docBase: web, path: '/hello' }])
    expect(await fs.readdir(path.join(base, 'conf', 'Catalina', 'localhost'))).toEqual(['hello.xml'])
    expect(parseXml(await fs.readFile(path.join(base, 'conf', 'Catalina', 'localhost', 'hello.xml'), 'utf8')).attrs).toEqual({ docBase: web })
    await first.cleanup()
    await expect(fs.stat(base)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.stat(second.env.CATALINA_BASE)).isDirectory()).toBe(true)
  })

  it('cleans an active private base on application shutdown', async () => {
    const p = preset()
    const runtime = await stage(await launch(p), p)
    const base = runtime.env.CATALINA_BASE
    expect((await fs.stat(path.join(base, 'conf', 'server.xml'))).isFile()).toBe(true)
    closeTomcatBases()
    await expect(fs.stat(base)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not use external web folders or follow links while looking for webapp candidates', async () => {
    const external = path.join(root, 'outside')
    await fs.mkdir(path.join(external, 'WEB-INF'), { recursive: true })
    await fs.symlink(external, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await fs.mkdir(path.join(project, 'src', 'main', 'webapp', 'WEB-INF'), { recursive: true })
    expect(await webappCandidates(project)).toEqual(expect.arrayContaining(['Web & Pages', 'src/main/webapp']))
    expect(await webappCandidates(project)).not.toContain('linked')
    const forbidden = preset({ webapp: 'linked' })
    await expect(stage(await launch(forbidden), forbidden)).rejects.toThrow('워크트리')
    const substituted = preset({ webapp: '${catalina.base}' })
    await fs.mkdir(path.join(project, substituted.webapp, 'WEB-INF'), { recursive: true })
    await expect(stage(await launch(substituted), substituted)).rejects.toThrow('실제 경로')
  })

  it('builds Tomcat classpaths from exploded output and verified Eclipse sources', async () => {
    const output = path.join(web, 'WEB-INF', 'classes')
    const lib = path.join(web, 'WEB-INF', 'lib')
    const containerLib = path.join(home, 'lib')
    const source = path.join(project, 'srcJava')
    await Promise.all([fs.mkdir(output), fs.mkdir(lib), fs.mkdir(containerLib), fs.mkdir(source)])
    await Promise.all(['src/test/java', 'fixtureSource', 'toolSource'].map(relative => fs.mkdir(path.join(project, relative), { recursive: true })))
    await Promise.all([fs.writeFile(path.join(lib, 'app.jar'), ''), fs.writeFile(path.join(containerLib, 'servlet-api.jar'), ''),
      fs.writeFile(path.join(project, '.classpath'), `<classpath>
        <classpathentry kind="src" path="srcJava" output="assembly"/>
        <classpathentry kind="src" path="src/test/java"/>
        <classpathentry kind="src" path="fixtureSource"><attributes><attribute name="test" value="true"/></attributes></classpathentry>
        <classpathentry kind="src" path="toolSource" output="target/tool-classes"/>
        <classpathentry kind="src" path="../outside"/>
        <classpathentry kind="output" path="assembly"/>
      </classpath>`)])
    const p = preset({ hotReload: 'standard' })
    const runtime = await stage(await launch(p), p)
    const layout = { classpath: [output, path.join(lib, 'app.jar'), path.join(containerLib, 'servlet-api.jar')], roots: [{ output, source, moduleRoot: project }] }
    expect(await tomcatLayout(project, project, web, home)).toEqual(layout)
    expect(runtime.hotReload).toMatchObject({ port: 59998, layout })
    expect(runtime.env.CATALINA_OPTS).toContain('quiet=y,address=127.0.0.1:59998')
    expect(runtime.filterOutput('59998\n')).not.toContain('59998')
    expect(await fs.readdir(path.join(runtime.env.CATALINA_BASE, 'conf', 'Catalina', 'localhost'))).toEqual(['ROOT.xml'])
  })

  it('reports missing WEB-INF/classes without adding a JDWP option', async () => {
    const p = preset({ hotReload: 'standard' })
    const runtime = await stage(await launch(p), p)
    expect(runtime.hotReloadFailure).toContain('WEB-INF/classes')
    expect(runtime.hotReload).toBeUndefined()
    expect(runtime.env.CATALINA_OPTS).toBe('')
    expect(catalinaOptions(["-Dmessage=O'Connor"], 'linux')).toBe("'-Dmessage=O'\\''Connor'")
    expect(() => catalinaOptions(['-Dfoo=x&whoami'], 'win32')).toThrow('특수 문자')
  })
})
