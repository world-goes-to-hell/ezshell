import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findLocalApacheTools, inspectLocalTomcat6, unpackedApacheHome } from './apacheToolHome.js'

let root
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-apache-home-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

function file(relative, contents = 'fixture') {
  const filename = path.join(root, relative)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, contents)
}

describe('Apache tool homes', () => {
  it('matches the requested archive folder and platform launcher without running scripts', () => {
    file('apache-maven-3.9.16/bin/mvn')
    expect(unpackedApacheHome(root, { tool: 'maven', version: '3.9.16' }, 'linux')).toBe(path.join(root, 'apache-maven-3.9.16'))
    expect(() => unpackedApacheHome(root, { tool: 'maven', version: '3.9.16' }, 'win32')).toThrow(/Apache 도구/)
    expect(() => unpackedApacheHome(root, { tool: 'maven', version: '../3.9.16' }, 'linux')).toThrow(/이름/)
  })

  it('reads the Tomcat 6 version from the selected local installation', () => {
    file('bin/catalina.bat')
    file('bin/bootstrap.jar')
    file('conf/server.xml')
    file('RELEASE-NOTES', '  Apache Tomcat Version 6.0.53\r\n')
    expect(inspectLocalTomcat6(root, 'win32')).toMatchObject({ home: fs.realpathSync(root), version: '6.0.53', folder: path.basename(root) })
    expect(inspectLocalTomcat6(root, 'linux')).toBeNull()
    file('RELEASE-NOTES', '  Apache Tomcat Version 7.0.109\r\n')
    expect(inspectLocalTomcat6(root, 'win32')).toBeNull()
  })

  it('rejects an incomplete installation or network path', () => {
    file('bin/catalina.bat')
    file('RELEASE-NOTES', 'Apache Tomcat Version 6.0.53\n')
    expect(inspectLocalTomcat6(root, 'win32')).toBeNull()
    expect(inspectLocalTomcat6('//server/share', 'win32')).toBeNull()
  })

  it('finds configured Tomcat, Maven, Ant and IntelliJ bundled Maven without running the tools', () => {
    file('tomcat/bin/catalina.bat')
    file('tomcat/bin/bootstrap.jar')
    file('tomcat/conf/server.xml')
    file('tomcat/RELEASE-NOTES', 'Apache Tomcat Version 6.0.53\n')
    file('apache-maven-3.6.3/bin/mvn.cmd')
    file('apache-ant-1.9.16/bin/ant.bat')
    file('Program Files/JetBrains/IntelliJ IDEA 2025/plugins/maven/lib/maven3/bin/mvn.cmd')
    file('Program Files/JetBrains/IntelliJ IDEA 2025/plugins/maven/lib/maven3/lib/maven-core-3.9.16.jar')
    const firstMaven = path.join(root, 'apache-maven-3.6.3')
    const found = findLocalApacheTools({ platform: 'win32', home: root, env: {
      CATALINA_HOME: path.join(root, 'tomcat'),
      MAVEN_HOME: firstMaven,
      M2_HOME: firstMaven,
      ANT_HOME: path.join(root, 'apache-ant-1.9.16'),
      ProgramFiles: path.join(root, 'Program Files')
    } }).filter(item => item.home.startsWith(fs.realpathSync(root)))
    expect(found).toHaveLength(4)
    expect(found).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'tomcat', version: '6.0.53', managed: false }),
      expect.objectContaining({ tool: 'ant', version: '1.9.16', managed: false }),
      expect.objectContaining({ tool: 'maven', version: '3.6.3', managed: false }),
      expect.objectContaining({ tool: 'maven', version: '3.9.16', folder: 'maven3', managed: false })
    ]))
  })
})
