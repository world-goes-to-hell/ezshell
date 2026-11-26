import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import { buildSync } from 'esbuild'

// CommonJS modules main.js loads at runtime with require('./src/...'); they are not bundled
const MAIN_RUNTIME_MODULES = ['crypto.js', 'commandHistory.js', 'sshConnectionTest.js', 'localFileOps.js', 'sftpSymlinks.js', 'sftpUploadCheck.js', 'userDataDir.js', 'navigationGuard.js', 'updateChecker.js', 'sshAlgorithms.js', 'rootSwitch.js', 'localShell.js', 'windowState.js', 'sftpListing.js', 'lastVersion.js', 'localPlaces.js', 'localKeyPath.js', 'manualUpdate.js', 'sharedConn.js', 'macMenu.js', 'nativeBackdrop.js', 'sftpDownloadDir.js', 'detachedPlaces.js', 'restoreTabs.js', 'sessionSecrets.js', 'agentIdle.js', 'agentHookReport.js', 'globalDoubleTab.js', 'quickCapture.js', 'quickCaptureOverlay.js', 'quickCaptureEditor.js', 'agentProjects.js', 'testWindows.js', 'globalPointer.js', 'globalPointerEffects.js']

// Directories under src/ that main.js loads at runtime; copied whole, without their tests
const MAIN_RUNTIME_DIRECTORIES = ['mcp', 'sessionLog', 'hostKeys', 'remoteFiles', 'dbClient', 'remoteAccess', 'sessionImport', 'containers', 'ipc', 'agentHistory', 'agentChat', 'localFiles', 'runtimes', 'sessionHost']

// The main process serves these beside the remote access page. Names match VENDOR in server.js.
const REMOTE_ACCESS_VENDOR: Record<string, string> = {
  'xterm.js': 'node_modules/xterm/lib/xterm.js',
  'xterm.css': 'node_modules/xterm/css/xterm.css',
  'xterm-addon-fit.js': 'node_modules/xterm-addon-fit/lib/xterm-addon-fit.js',
  'app-icon.svg': 'src/renderer/assets/app-icon.svg',
  'PretendardVariable.woff2': 'src/renderer/assets/fonts/PretendardVariable.woff2',
  'JetBrainsMono-Regular.woff2': 'src/renderer/assets/fonts/JetBrainsMono-Regular.woff2',
  'D2Coding-Regular.woff2': 'src/renderer/assets/fonts/D2Coding-Regular.woff2',
  'title-bar.css': 'src/renderer/styles/app/title-bar.css',
  'agent-work-trace.css': 'src/renderer/styles/app/agent-work-trace.css',
  'terminal-tabs.css': 'src/renderer/styles/app/terminal-tabs.css'
}

// Scripts that agents in a local shell start on their own (message MCP, hooks, status lines, the ezshell
// command). Each is bundled into one file under out/main/agent-runtime: the session host's runtime copy
// carries that folder outside the install folder, so a running agent never holds the install folder
// during an update (docs/plan/2026-11-26-sessions-survive-update.md). Names are what agentRuntimePaths expects.
const AGENT_RUNTIME_ENTRIES: Record<string, string> = {
  agentMessageMcp: 'src/ipc/agentMessageMcp.js',
  agentMessageCli: 'src/ipc/agentMessageCli.js',
  agentHookReport: 'src/agentHookReport.js',
  agentUsageReport: 'src/ipc/agentUsageReport.js',
  antigravityStatusReport: 'src/ipc/antigravityStatusReport.js'
}

function agentRuntimePlugin() {
  return {
    name: 'agent-runtime',
    closeBundle() {
      const outdir = path.resolve(__dirname, 'out/main/agent-runtime')
      fs.rmSync(outdir, { recursive: true, force: true })
      buildSync({
        entryPoints: Object.fromEntries(Object.entries(AGENT_RUNTIME_ENTRIES).map(([name, file]) => [name, path.resolve(__dirname, file)])),
        outdir,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        external: ['electron'],
        logLevel: 'warning'
      })
    }
  }
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
          filter: (source) => !source.endsWith('.test.js') && !source.endsWith('.testhelper.js') && path.basename(source) !== 'fixtures'
        })
      }
      const vendorDir = path.resolve(__dirname, 'out/main/src/remoteAccess/web/vendor')
      fs.mkdirSync(vendorDir, { recursive: true })
      for (const [name, source] of Object.entries(REMOTE_ACCESS_VENDOR)) {
        fs.copyFileSync(path.resolve(__dirname, source), path.join(vendorDir, name))
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [copyCryptoPlugin(), agentRuntimePlugin()],
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
          index: path.resolve(__dirname, 'src/preload.js'),
          'pointer-effects': path.resolve(__dirname, 'src/preloadPointerEffects.js')
        }
      }
    }
  },
  renderer: {
    root: path.resolve(__dirname, 'src/renderer'),
    // Not Vite's default 5173: other Vite projects on this machine use it, and on Windows
    // both servers can listen on it at once (keep in sync with DEV_RENDERER_URL in main.js)
    server: {
      port: 15173,
      // A changed .html anywhere it watches reloads the whole window, and a reload drops every tab
      // while their local shells (and the agents in them) keep running in main. Design mockups,
      // build output (another session's `npm run build` rewrites out/renderer/*.html) and test
      // output are not part of the renderer.
      watch: {
        ignored: ['**/mockups/**', '**/out/**', '**/release/**', '**/dist/**', '**/e2e/**', '**/docs/**']
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html'),
          startup: path.resolve(__dirname, 'src/renderer/startup.html'),
          'pointer-effects': path.resolve(__dirname, 'src/renderer/pointer-effects.html')
        }
      }
    },
    plugins: [react()]
  }
})
