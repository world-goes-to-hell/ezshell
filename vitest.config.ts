import { configDefaults, defineConfig } from 'vitest/config'

// Unit tests are next to the code in src/. Other folders can hold copies of the whole repository
// (a session building in a temporary copy under e2e/.out, build output in out/ and release/): their
// tests ran a second time in parallel, and two copies of a test that listens on a fixed port
// (src/remoteAccess/server.test.js) failed each other with EADDRINUSE.
// Tests run from an agent shell opened in ezShell inherit its EZSHELL_* variables (agent pipe,
// token, shell token). A test that starts the message bridge then connected to the real app with
// that agent's token instead of the test server, and the real agent's MCP connection dropped.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('EZSHELL_')) delete process.env[name]
}

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**', 'out/**', 'release/**', 'mockups/**', 'docs/**']
  }
})
