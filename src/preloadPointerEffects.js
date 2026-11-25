const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pointerEffectsOverlay', {
  onFrame(callback) {
    const listener = (_event, packet) => callback(packet)
    ipcRenderer.on('pointer-effects-frame', listener)
    return () => ipcRenderer.removeListener('pointer-effects-frame', listener)
  }
})
