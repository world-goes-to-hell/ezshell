import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { importTomcatIde } from './tomcatIdeImport.js'

let fixture
let root

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'ezshell-ide-tomcat-')))
  root = path.join(fixture, 'project')
  await mkdir(root)
})
afterEach(async () => rm(fixture, { recursive: true, force: true }))

async function write(base, relative, text) {
  const file = path.join(base, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
  return file
}

describe('IDE Tomcat settings', () => {
  it('reads IntelliJ local deployments, a built artifact and a Smart Tomcat module', async () => {
    const cwd = path.join(root, 'service')
    await write(root, 'out/web/WEB-INF/web.xml', '<web-app/>')
    await write(root, 'service/WebContent/WEB-INF/web.xml', '<web-app/>')
    await write(root, 'service/WebContent/META-INF/context.xml', '<Context><Resource password="not-in-draft"/></Context>')
    await write(root, '.idea/artifacts/Web.xml', `
      <component name="ArtifactManager"><artifact type="exploded-war" name="web:war exploded">
        <output-path>$PROJECT_DIR$/out/web</output-path></artifact></component>`)
    await write(root, '.run/Tomcat.run.xml', `
      <component name="ProjectRunConfigurationManager">
        <configuration name="IDE server" type="#com.intellij.j2ee.web.tomcat.TomcatRunConfigurationFactory" factoryName="Local">
          <deployment><artifact name="web:war exploded"><settings><option name="CONTEXT_PATH" value="/shop"/></settings></artifact></deployment>
          <server-settings><option name="HTTP_PORT" value="8181"/></server-settings>
          <ConfigurationWrapper RunnerId="Debug"><option name="VM_PARAMETERS" value="-Xmx9g"/></ConfigurationWrapper>
          <ConfigurationWrapper RunnerId="Run"><option name="VM_PARAMETERS" value="-Xmx512m -Dapp.token=hidden"/></ConfigurationWrapper>
        </configuration>
        <configuration name="IDE remote" type="#com.intellij.j2ee.web.tomcat.TomcatRunConfigurationFactory" factoryName="Remote"/>
        <configuration name="Boot" type="SpringBootApplicationConfigurationType"/>
      </component>`)
    await write(cwd, '.idea/workspace.xml', `
      <project><component name="RunManager">
        <configuration name="Smart" type="com.poratu.idea.plugins.tomcat">
          <option name="port" value="8182"/><option name="docBase" value="$PROJECT_DIR$/WebContent"/>
          <option name="contextPath" value="/smart"/><option name="vmOptions" value="-Xms256m --add-opens java.base/java.lang=ALL-UNNAMED"/>
        </configuration>
      </component></project>`)
    const result = await importTomcatIde(root, cwd)
    expect(result.servers).toEqual([
      { name: 'Smart', source: 'Smart Tomcat', webapp: 'service/WebContent', port: 8182, contextPath: '/smart',
        vmArgs: '-Xms256m --add-opens=java.base/java.lang=ALL-UNNAMED', contextXml: 'service/WebContent/META-INF/context.xml' },
      { name: 'IDE server', source: 'IntelliJ', webapp: 'out/web', port: 8181, contextPath: '/shop', vmArgs: '-Xmx512m' }
    ])
    expect(result.notes).toHaveLength(1)
    expect(JSON.stringify(result)).not.toMatch(/not-in-draft|hidden|9g/)
  })

  it('reads VS Code JSONC bootstrap launches and the referenced project Tomcat configuration', async () => {
    const workspace = '$' + '{workspaceFolder}'
    await write(root, 'service/WebContent/WEB-INF/web.xml', '<web-app/>')
    await write(root, 'service/tomcat/conf/server.xml', `
      <Server><Service><Connector port="8443" SSLEnabled="true"/><Connector port="8183" protocol="HTTP/1.1"/>
      <Engine><Host appBase=".."><Context path="/code" docBase="WebContent"/></Host></Engine></Service></Server>`)
    await write(root, '.vscode/launch.json', `{
      // launch with a module-specific working directory
      "configurations": [
        {"type":"java","request":"launch","name":"Java Tomcat","mainClass":"org.apache.catalina.startup.Bootstrap",
         "cwd":"${workspace}/service","vmArgs":["-Dcatalina.base=tomcat","-Dlocal.name=Two Words","-javaagent:outside.jar"],
         "preLaunchTask":"not an imported task"},
        {"type":"java","request":"attach","name":"Attach","mainClass":"org.apache.catalina.startup.Bootstrap"},
        {"type":"java","request":"launch","name":"Boot","mainClass":"App"},
      ],
    }`)
    expect(await importTomcatIde(root, root)).toMatchObject({
      servers: [{ name: 'Java Tomcat', source: 'VS Code', port: 8183, contextPath: '/code', webapp: 'service/WebContent',
        vmArgs: '"-Dlocal.name=Two Words"' }],
      notes: [expect.stringContaining('VM 인자')]
    })
  })

  it('reads a selected Community Server Connectors file without following unrelated deployment paths', async () => {
    const outside = path.join(fixture, 'external')
    await write(outside, 'web/WEB-INF/web.xml', '<web-app/>')
    await write(outside, 'conf/server.xml', '<Server><Service><Connector port="9999"/></Service></Server>')
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await write(fixture, 'Tomcat 10', JSON.stringify({
      id: 'Tomcat 10', 'org.jboss.tools.rsp.server.typeId': 'org.jboss.ide.eclipse.as.server.tomcat.100',
      'server.http.port': '8184', 'server.base.dir': 'linked', 'args.override.boolean': 'true',
      'args.vm.override.string': '-Dcatalina.home=hidden -Ddb.password=hidden -Xms256m',
      deployables: { web: { path: 'linked/web', options: { option: { 'deployment.output.name': 'shop' } } } }
    }))
    expect((await importTomcatIde(root, root, result)).servers).toEqual([
      { name: 'Tomcat 10', source: 'VS Code · Community Server Connectors', port: 8184, vmArgs: '-Xms256m', contextPath: '/shop' }
    ])
    await write(root, '.idea/workspace.xml', '<!DOCTYPE project SYSTEM "file:///unrelated"><project/>')
    const scanned = await importTomcatIde(root, root)
    expect(scanned).toEqual({ servers: [], notes: ['읽을 수 없는 IDE 설정 파일이 있습니다.'] })
  })
})
