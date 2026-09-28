import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

// CommonJS modules main.js loads at runtime with require('./src/...'); they are not bundled
const MAIN_RUNTIME_MODULES = ['crypto.js', 'commandHistory.js']

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
