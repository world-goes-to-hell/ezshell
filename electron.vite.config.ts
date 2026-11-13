import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

// CommonJS modules main.js loads at runtime with require('./src/...'); they are not bundled
const MAIN_RUNTIME_MODULES = ['crypto.js', 'commandHistory.js', 'sshConnectionTest.js', 'localFileOps.js', 'sftpSymlinks.js', 'sftpUploadCheck.js', 'userDataDir.js', 'navigationGuard.js', 'updateChecker.js', 'sshAlgorithms.js', 'rootSwitch.js', 'localShell.js', 'windowState.js', 'sftpListing.js', 'lastVersion.js']

// Directories under src/ that main.js loads at runtime; copied whole, without their tests
const MAIN_RUNTIME_DIRECTORIES = ['mcp', 'sessionLog', 'hostKeys', 'remoteFiles', 'dbClient', 'remoteAccess']

// The terminal library of the remote access page (a phone's browser), served by the main process.
// xterm is a devDependency (the renderer bundles it), so the packaged app has no copy to serve:
// these are copied next to the page. Names must match VENDOR in src/remoteAccess/server.js.
const REMOTE_ACCESS_VENDOR: Record<string, string> = {
  'xterm.js': 'xterm/lib/xterm.js',
  'xterm.css': 'xterm/css/xterm.css',
  'xterm-addon-fit.js': 'xterm-addon-fit/lib/xterm-addon-fit.js'
}

function copyCryptoPlugin() {
  return {
    name: 'copy-crypto',
    closeBundle() {
      fs.mkdirSync(path.resolve(__dirname, 'out/main/src'), { recursive: true })
      for (const file of MAIN_RUNTIME_MODULES) {
        fs.copyFileSync(
          path.resolve(__dirname, 'src', file),
          path.resolve(__dirname, 'out/main/src', file)
        )
      }
      // Window / taskbar icon, loaded by main.js next to the bundle (assets/ is not packaged)
      fs.copyFileSync(path.resolve(__dirname, 'assets/icon.ico'), path.resolve(__dirname, 'out/main/icon.ico'))
      for (const dir of MAIN_RUNTIME_DIRECTORIES) {
        fs.cpSync(path.resolve(__dirname, 'src', dir), path.resolve(__dirname, 'out/main/src', dir), {
          recursive: true,
          filter: (source) => !source.endsWith('.test.js') && !source.endsWith('.testhelper.js')
        })
      }
      const vendorDir = path.resolve(__dirname, 'out/main/src/remoteAccess/web/vendor')
      fs.mkdirSync(vendorDir, { recursive: true })
      for (const [name, source] of Object.entries(REMOTE_ACCESS_VENDOR)) {
        fs.copyFileSync(path.resolve(__dirname, 'node_modules', source), path.join(vendorDir, name))
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [copyCryptoPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'main.js')
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/preload.js')
        }
      }
    }
  },
  renderer: {
    root: path.resolve(__dirname, 'src/renderer'),
    // Not Vite's default 5173: other Vite projects on this machine use it, and on Windows
    // both servers can listen on it at once (keep in sync with DEV_RENDERER_URL in main.js)
    server: {
      port: 15173
    },
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react()]
  }
})
