// Exercise the real capture overlay without reading the desktop or changing the system clipboard.
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const profile = app.commandLine.getSwitchValue('user-data-dir')

const hotkey = require('../../out/main/src/globalDoubleTab.js')
hotkey.createGlobalDoubleTab = ({ onCapture, onCaptureCancel }) => {
  const request = path.join(profile, 'capture-request')
  const cancel = path.join(profile, 'capture-cancel')
  let timer
  let capturing = false
  return {
    start() {
      timer = setInterval(() => {
        if (fs.existsSync(request)) {
          fs.unlinkSync(request)
          if (!capturing) {
            capturing = true
            onCapture()
          }
        }
        if (fs.existsSync(cancel)) {
          fs.unlinkSync(cancel)
          onCaptureCancel()
        }
      }, 50)
      timer.unref()
    },
    stop() { clearInterval(timer) },
    setEnabled() {},
    focusCapture() {},
    endCapture() { capturing = false }
  }
}

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
  clipboard: { write: async () => fs.writeFileSync(path.join(profile, 'capture-copied'), '') },
  onSent: () => {}
})

require('./agentChatApp.js')
