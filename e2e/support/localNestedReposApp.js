const { app, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const profile = app.commandLine.getSwitchValue('user-data-dir')
const original = dialog.showMessageBox.bind(dialog)
dialog.showMessageBox = (parent, options) => {
  if (options?.title !== '자동으로 원격 확인') return original(parent, options)
  const project = path.join(profile, 'shop-msa')
  if (!options.detail.includes(project) || !options.detail.includes('.git/config')) {
    return Promise.reject(new Error('Trust confirmation must identify the registered project and its settings'))
  }
  fs.writeFileSync(path.join(profile, 'nested-trust-prompt.txt'), options.detail)
  return Promise.resolve({ response: fs.existsSync(path.join(profile, 'accept-nested-trust')) ? 1 : 0 })
}
require('../../out/main/index.js')
