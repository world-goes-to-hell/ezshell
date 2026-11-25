// Inject HTTPS responses before the built main process creates its JDK manager.
const runtimes = require('../../out/main/src/runtimes/index.js')
const { fakeTemurin } = require('./jdkFixture.js')
const createRuntimes = runtimes.createRuntimes
runtimes.createRuntimes = options => createRuntimes({ ...options, platform: 'win32', arch: 'x64', request: fakeTemurin() })
require('../../out/main/index.js')
