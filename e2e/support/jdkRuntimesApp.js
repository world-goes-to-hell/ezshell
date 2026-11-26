// Inject HTTPS responses before the built main process creates its JDK manager.
const fs = require('node:fs')
const path = require('node:path')
const runtimes = require('../../out/main/src/runtimes/index.js')
const ipc = require('../../out/main/src/runtimes/ipc.js')
const { fakeApache, fakeEnhanced, fakeGradleNode, tomcatFiles } = require('./jdkFixture.js')
const createRuntimes = runtimes.createRuntimes
let tomcatFolder
runtimes.createRuntimes = options => {
  tomcatFolder = path.join(options.userData, 'tomcat-6-fixture')
  for (const [name, contents] of Object.entries({ ...tomcatFiles, 'RELEASE-NOTES': 'Apache Tomcat Version 6.0.53\n' })) {
    const filename = path.join(tomcatFolder, name)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, contents)
  }
  const apache = fakeApache()
  const jdk = fakeEnhanced()
  const gradleNode = fakeGradleNode()
  const request = (url, ...args) => {
    if (['downloads.apache.org', 'archive.apache.org'].includes(url.hostname)) return apache(url, ...args)
    if (['services.gradle.org', 'nodejs.org'].includes(url.hostname)) return gradleNode(url, ...args)
    return jdk(url, ...args)
  }
  const localNode = path.join(options.userData, 'local-node', 'v24.14.0')
  fs.mkdirSync(localNode, { recursive: true })
  fs.writeFileSync(path.join(localNode, 'node.exe'), 'fixture')
  return createRuntimes({ ...options, env: { ...process.env, NODE_HOME: localNode }, platform: 'win32', arch: 'x64', request })
}
const registerIpc = ipc.registerRuntimesIpc
ipc.registerRuntimesIpc = options => registerIpc({ ...options, chooseTomcatFolder: async () => tomcatFolder })
require('../../out/main/index.js')
