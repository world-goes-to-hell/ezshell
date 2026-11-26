import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerLocalProjectIpc } from './localProjects.js'

let root
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-open-folder-')) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function setup({ locked = false, failure = '' } = {}) {
  const handlers = new Map()
  const openFolder = vi.fn(async () => failure)
  const sender = { mainFrame: {} }
  registerLocalProjectIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    fromMainWindow: event => event.sender === sender, isLocked: () => locked, openFolder
  })
  const open = (folder, event = { sender, senderFrame: sender.mainFrame }) => handlers.get('local-project-open-folder')(event, folder)
  return { open, openFolder, sender }
}

describe('opening a local project folder in the file manager', () => {
  it('opens the real folder of a local project', async () => {
    const { open, openFolder } = setup()
    expect(await open(root)).toEqual({ success: true })
    expect(openFolder).toHaveBeenCalledExactlyOnceWith(fs.realpathSync.native(root))
  })

  it('opens nothing but a local folder, from the unlocked main window\u2019s main frame', async () => {
    const file = path.join(root, 'run.cmd')
    fs.writeFileSync(file, 'echo no')
    const { open, openFolder, sender } = setup()
    for (const folder of [file, path.join(root, 'missing'), 'relative', '\\\\server\\share\\project', '\\\\?\\C:\\', 42, null]) {
      expect(await open(folder)).toMatchObject({ success: false, error: expect.any(String) })
    }
    expect(await open(root, { sender, senderFrame: {} })).toMatchObject({ success: false })
    expect(await open(root, { sender: {}, senderFrame: {} })).toMatchObject({ success: false })
    expect(await setup({ locked: true }).open(root)).toMatchObject({ success: false })
    expect(openFolder).not.toHaveBeenCalled()
  })

  it('says so when the file manager cannot open it', async () => {
    expect(await setup({ failure: 'no handler' }).open(root)).toEqual({ success: false, error: '파일 탐색기로 열지 못했습니다.' })
  })
})
