// Exercise the real capture overlay without reading the desktop or changing the system clipboard.
const { app, nativeImage } = require('electron')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const profile = app.commandLine.getSwitchValue('user-data-dir')

const hotkey = require('../../out/main/src/globalDoubleTab.js')
const createGlobalDoubleTab = hotkey.createGlobalDoubleTab
hotkey.createGlobalDoubleTab = options => createGlobalDoubleTab({ ...options, allowNativeHook: true, spawn: () => {
  const child = new EventEmitter()
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
  const emit = line => child.stdout.emit('data', line + '\n')
  let enabled = false
  let capturing = false
  let bindings = []
  const take = name => {
    const file = path.join(profile, name)
    if (!fs.existsSync(file)) return null
    const value = fs.readFileSync(file, 'utf8')
    fs.unlinkSync(file)
    return value.trim()
  }
  const timer = setInterval(() => {
    const requested = enabled ? take('capture-request') : null
    if (!capturing && (requested === '' || bindings.includes(requested))) {
      capturing = true
      emit(requested && !requested.endsWith(' 0') ? 'capture-press' : 'capture')
    }
    if (take('capture-release') !== null && enabled) emit('capture-release')
    if (take('capture-cancel') !== null && enabled) emit('capture-cancel')
  }, 50)
  timer.unref()
  child.stdin = Object.assign(new EventEmitter(), {
    write(line) {
      if (line === 'on\n' || line === 'off\n') enabled = line === 'on\n'
      if (line === 'off\n' || line === 'capture-end\n') capturing = false
      if (line.startsWith('bindings ')) {
        const [, firstMods, firstVk, secondMods, secondVk] = line.trim().split(' ')
        bindings = [`${firstMods} ${firstVk}`, `${secondMods} ${secondVk}`].filter(binding => binding !== '0 0')
        fs.writeFileSync(path.join(profile, 'capture-bindings'), bindings.join('\n'))
      }
    },
    end() { clearInterval(timer) }
  })
  child.kill = () => clearInterval(timer)
  queueMicrotask(() => emit('ready'))
  return child
} })

const capture = require('../../out/main/src/quickCapture.js')
const createQuickCapture = capture.createQuickCapture
capture.createQuickCapture = options => createQuickCapture({
  ...options,
  async repoFolders(cwd) {
    const hold = path.join(profile, 'capture-projects-hold')
    if (fs.existsSync(hold)) {
      fs.writeFileSync(path.join(profile, 'capture-projects-opening'), '')
      for (let attempt = 0; attempt < 250 && fs.existsSync(hold); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    return options.repoFolders(cwd)
  },
  desktopCapturer: {
    async getSources() {
      const hold = path.join(profile, 'capture-hold')
      if (fs.existsSync(hold)) {
        fs.writeFileSync(path.join(profile, 'capture-opening'), '')
        for (let attempt = 0; attempt < 160 && fs.existsSync(hold); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      const { id } = options.getDisplay()
      const thumbnail = nativeImage.createFromBitmap(Buffer.alloc(800 * 600 * 4, 255), { width: 800, height: 600 })
      return [{ display_id: String(id), thumbnail }]
    }
  },
  // The copied picture is kept so the spec can read its size (several captures are stacked into one)
  clipboard: {
    async write([item]) {
      const png = Buffer.from(await (await item.getType('image/png')).arrayBuffer())
      fs.writeFileSync(path.join(profile, 'capture-copied'), png)
    }
  },
  onSent: () => {},
  // The app's output is not kept: a failed capture leaves its reason for the spec to show
  onError: error => fs.appendFileSync(path.join(profile, 'capture-error'), String(error?.stack ?? error) + '\n')
})

require('./agentChatApp.js')
