// Inject HTTPS responses before the built main process creates its JDK manager.
const fs = require('node:fs')
const path = require('node:path')
const runtimes = require('../../out/main/src/runtimes/index.js')
const ipc = require('../../out/main/src/runtimes/ipc.js')
const { fakeApache, fakeEnhanced, tomcatFiles } = require('./jdkFixture.js')
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
  const request = (url, ...args) => url.hostname === 'downloads.apache.org' || url.hostname === 'archive.apache.org'
    ? apache(url, ...args) : jdk(url, ...args)
  return createRuntimes({ ...options, platform: 'win32', arch: 'x64', request })
}
const registerIpc = ipc.registerRuntimesIpc
ipc.registerRuntimesIpc = options => registerIpc({ ...options, chooseTomcatFolder: async () => tomcatFolder })
require('../../out/main/index.js')
