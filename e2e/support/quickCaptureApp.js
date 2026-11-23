// Exercise the real capture overlay without reading the desktop or changing the system clipboard.
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const profile = app.commandLine.getSwitchValue('user-data-dir')

const hotkey = require('../../out/main/src/globalDoubleTab.js')
hotkey.createGlobalDoubleTab = ({ onCapture }) => {
  const request = path.join(profile, 'capture-request')
  let timer
  return {
    start() {
      timer = setInterval(() => {
        if (!fs.existsSync(request)) return
        fs.unlinkSync(request)
        onCapture()
      }, 50)
      timer.unref()
    },
    stop() { clearInterval(timer) },
    setEnabled() {}
  }
}

const capture = require('../../out/main/src/quickCapture.js')
const createQuickCapture = capture.createQuickCapture
capture.createQuickCapture = options => createQuickCapture({
  ...options,
  desktopCapturer: {
    async getSources() {
      const { id } = options.getDisplay()
      const thumbnail = nativeImage.createFromBitmap(Buffer.alloc(800 * 600 * 4, 255), { width: 800, height: 600 })
      return [{ display_id: String(id), thumbnail }]
    }
  },
  clipboard: { write: async () => fs.writeFileSync(path.join(profile, 'capture-copied'), '') },
  onSent: () => {}
})

require('./agentChatApp.js')
