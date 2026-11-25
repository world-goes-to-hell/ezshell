import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { WORKSPACE_SCHEME, workspaceDocument, workspacePreview, serveWorkspaceAsset, resolveLinkFolder } from './browserWorkspace.js'

const host = 'workspace-test'
const url = relative => `${WORKSPACE_SCHEME}://${host}/${relative}`
const read = (relative, previews) => serveWorkspaceAsset({ url: url(relative), method: 'GET' }, previews)
let directory, root

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ezshell-workspace-preview-'))
  root = path.join(directory, 'project')
  await fs.mkdir(root)
})

afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }) })

it('uses a scoped URL for an approved document and serves fresh relative assets', async () => {
  const html = '데모 #1.HTML'
  await fs.writeFile(path.join(root, html), '<h1>Workspace demo</h1>')
  await fs.writeFile(path.join(root, 'style.css'), 'h1 { color: red }')
  const preview = await workspacePreview(root, html)
  const previews = new Map([[host, preview]])
  expect(workspaceDocument(url(preview.path), host)).toBe(html)
  expect(workspaceDocument(url('style.css'), host)).toBeNull()
  expect(await (await read(preview.path, previews)).text()).toBe('<h1>Workspace demo</h1>')
  const style = await read('style.css', previews)
  expect(style.headers.get('content-type')).toBe('text/css')
  expect(await style.text()).toBe('h1 { color: red }')
  await fs.writeFile(path.join(root, 'style.css'), '')
  expect(await (await read('style.css', previews)).text()).toBe('')
  previews.clear()
  expect((await read(preview.path, previews)).status).toBe(404)
})

it('refuses directories, files outside the workspace and unrelated local resources', async () => {
  const sibling = path.join(directory, 'outside')
  await fs.mkdir(sibling)
  await fs.mkdir(path.join(root, 'folder.html'))
  await fs.writeFile(path.join(sibling, 'other.html'), '<p>Outside the workspace</p>')
  await fs.symlink(sibling, path.join(root, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir')
  await fs.writeFile(path.join(root, 'private.env'), 'local fixture')
  const previews = new Map([[host, { root }]])
  for (const relative of ['../outside/other.html', 'folder.html', 'shortcut/other.html']) {
    await expect(workspacePreview(root, relative)).rejects.toThrow()
  }
  for (const relative of ['%2e%2e%2foutside%2fother.html', 'shortcut/other.html', 'private.env', '.git/config.json']) {
    expect((await read(relative, previews)).status).toBe(404)
  }
})

// A chat link outside every workspace (2026-11-25 user report: a scratchpad page was refused)
it('serves a linked folder without its dot files or JSON', async () => {
  await fs.writeFile(path.join(root, 'page.html'), '<link rel="stylesheet" href="page.css">')
  await fs.writeFile(path.join(root, 'page.css'), 'body{}')
  await fs.writeFile(path.join(root, 'tokens.json'), '{"token":"x"}')
  await fs.writeFile(path.join(root, '.claude.json'), '{}')
  await fs.mkdir(path.join(root, '.ssh'))
  await fs.writeFile(path.join(root, '.ssh', 'key.svg'), '<svg/>')
  const folder = await resolveLinkFolder(root)
  const preview = await workspacePreview(folder, 'page.html', true)
  const previews = new Map([[host, preview]])
  expect((await read('page.html', previews)).status).toBe(200)
  expect((await read('page.css', previews)).status).toBe(200)
  expect((await read('tokens.json', previews)).status).toBe(404)
  expect((await read('.claude.json', previews)).status).toBe(404)
  expect((await read('.ssh/key.svg', previews)).status).toBe(404)
  await expect(workspacePreview(folder, '.hidden.html', true)).rejects.toThrow()
})

it('takes only a local folder below a drive root as a linked folder', async () => {
  await fs.writeFile(path.join(root, 'page.html'), '')
  await expect(resolveLinkFolder(path.join(root, 'page.html'))).rejects.toThrow()
  await expect(resolveLinkFolder(path.parse(root).root)).rejects.toThrow()
  await expect(resolveLinkFolder('\\\\host\\share')).rejects.toThrow()
})
