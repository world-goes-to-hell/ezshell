import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { agentProjects, projectFolder, preferredProject } from './agentProjects.js'

const shop = path.resolve('shop')
const shopFix = path.resolve('shop-fix')
const blog = path.resolve('blog')
const folders = folder => folder.startsWith(blog) ? [blog] : folder.startsWith(shop) ? [folder, shop, shopFix] : []

describe('agent projects', () => {
  it('finds the project of a folder: the main checkout of its repository, or the folder outside Git', async () => {
    expect(await projectFolder(shopFix, folders)).toBe(shop)
    expect(await projectFolder(path.join(blog, 'src'), folders)).toBe(blog)
    expect(await projectFolder(path.resolve('notes'), folders)).toBe(path.resolve('notes'))
  })

  it('picks the project the browser tab was opened from, matching case and separators loosely', async () => {
    const projects = await agentProjects([{ id: 'claude-1', cwd: blog }, { id: 'codex-2', cwd: shopFix }], folders)
    expect(await preferredProject(projects, shopFix, folders)).toBe(shop)
    expect(await preferredProject(projects, blog.toUpperCase(), folders)).toBe(blog)
    expect(await preferredProject(projects, path.resolve('notes'), folders)).toBeNull()
    expect(await preferredProject(projects, null, folders)).toBeNull()
  })

  it('does not look up a folder that is not a local absolute path', async () => {
    const looked = []
    const spy = folder => { looked.push(folder); return folders(folder) }
    const projects = await agentProjects([{ id: 'claude-1', cwd: blog }], spy)
    looked.length = 0
    for (const hint of ['\\server\share\blog', 'blog', '', 42]) expect(await preferredProject(projects, hint, spy)).toBeNull()
    expect(looked).toEqual([])
  })
})
