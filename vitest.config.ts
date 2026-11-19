import { configDefaults, defineConfig } from 'vitest/config'

// Unit tests are next to the code in src/. Other folders can hold copies of the whole repository
// (a session building in a temporary copy under e2e/.out, build output in out/ and release/): their
// tests ran a second time in parallel, and two copies of a test that listens on a fixed port
// (src/remoteAccess/server.test.js) failed each other with EADDRINUSE.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**', 'out/**', 'release/**', 'mockups/**', 'docs/**']
  }
})
