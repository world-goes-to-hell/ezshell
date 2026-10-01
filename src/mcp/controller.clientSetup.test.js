import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import controllerModule from './controller.js'

const { createMcpController } = controllerModule

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'))

function setup({ setTokenEnv = vi.fn(async () => ({ status: 'set' })) } = {}) {
  const userDataPath = tempDir('mcp-setup-userdata-')
  const homeDir = tempDir('mcp-setup-home-')
  const server = () => ({ start: async () => {}, stop: async () => {}, isRunning: () => false, port: () => null })
  const controller = createMcpController({
    userDataPath,
    version: 'test',
    isUnlocked: () => true,
    loadSessions: () => [],
    loadFolders: () => [],
    showApproval: () => true,
    dismissApproval: () => {},
    deps: {
      createServer: server,
      approvals: { cancelAll: vi.fn(), respond: vi.fn(), request: vi.fn() },
      gateway: { closeAll: vi.fn(), forgetCwds: vi.fn(), getCwd: () => null },
      homeDir,
      setTokenEnv
    }
  })
  const { port, token } = controller.getStatus().config
  return { controller, homeDir, setTokenEnv, port, token }
}

describe('controller.setupClient', () => {
  it('writes a project .mcp.json that names the token variable and sets that variable', async () => {
    const { controller, setTokenEnv, port, token } = setup()
    const projectDir = tempDir('mcp-setup-project-')
    const outcome = await controller.setupClient({ scope: 'project', projectDir, setTokenEnv: true })
    const filePath = path.join(projectDir, '.mcp.json')
    expect(outcome).toMatchObject({ scope: 'project', filePath, result: 'added', tokenEnv: 'set' })
    expect(readJson(filePath).mcpServers['my-ssh-client']).toEqual({
      type: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: 'Bearer ${EZSHELL_MCP_TOKEN}' }
    })
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain(token)
    expect(setTokenEnv).toHaveBeenCalledWith(token)
  })

  it('leaves the environment alone when not asked, and on a conflict', async () => {
    const { controller, setTokenEnv } = setup()
    const projectDir = tempDir('mcp-setup-project-')
    expect((await controller.setupClient({ scope: 'project', projectDir, setTokenEnv: false })).tokenEnv).toBeNull()
    fs.writeFileSync(path.join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'my-ssh-client': { url: 'old' } } }))
    const conflict = await controller.setupClient({ scope: 'project', projectDir, setTokenEnv: true })
    expect(conflict).toMatchObject({ result: 'conflict', existingUrl: 'old', tokenEnv: null })
    expect(setTokenEnv).not.toHaveBeenCalled()
  })

  it('warns about a local-scope registration in ~/.claude.json that wins over the project file', async () => {
    const { controller, homeDir } = setup()
    const projectDir = tempDir('mcp-setup-project-')
    const asSaved = projectDir.replace(/\\/g, '/')
    fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({ projects: { [asSaved]: { mcpServers: { 'my-ssh-client': { url: 'old' } } } } }))
    const outcome = await controller.setupClient({ scope: 'project', projectDir })
    expect(outcome.result).toBe('added')
    expect(outcome.shadowedProjects).toEqual([asSaved])
    expect(readJson(path.join(homeDir, '.claude.json')).projects[asSaved].mcpServers['my-ssh-client']).toEqual({ url: 'old' })
  })

  it('writes the token itself into ~/.claude.json for the global scope', async () => {
    const { controller, homeDir, token, setTokenEnv } = setup()
    const filePath = path.join(homeDir, '.claude.json')
    fs.writeFileSync(filePath, JSON.stringify({ numStartups: 1 }))
    const outcome = await controller.setupClient({ scope: 'global', setTokenEnv: true })
    expect(outcome).toMatchObject({ scope: 'global', filePath, result: 'added', tokenEnv: null })
    expect(readJson(filePath).mcpServers['my-ssh-client'].headers).toEqual({ Authorization: `Bearer ${token}` })
    expect(readJson(filePath).numStartups).toBe(1)
    expect(setTokenEnv).not.toHaveBeenCalled()
  })

  it('does not create ~/.claude.json', async () => {
    const { controller, homeDir } = setup()
    await expect(controller.setupClient({ scope: 'global' })).rejects.toThrow('Claude Code 를 한 번 실행')
    expect(fs.existsSync(path.join(homeDir, '.claude.json'))).toBe(false)
  })

  it.each([
    ['an unknown scope', { scope: 'system' }, '설정 범위'],
    ['a relative project folder', { scope: 'project', projectDir: 'work' }, '프로젝트 폴더'],
    ['a missing project folder', { scope: 'project' }, '프로젝트 폴더'],
    ['a folder that does not exist', { scope: 'project', projectDir: path.join(os.tmpdir(), 'no-such-dir-ezshell') }, '프로젝트 폴더']
  ])('refuses %s', async (label, request, message) => {
    const { controller } = setup()
    await expect(controller.setupClient(request)).rejects.toThrow(message)
  })

  it('refuses a project folder that is a file', async () => {
    const { controller } = setup()
    const filePath = path.join(tempDir('mcp-setup-project-'), 'file.txt')
    fs.writeFileSync(filePath, 'x')
    await expect(controller.setupClient({ scope: 'project', projectDir: filePath })).rejects.toThrow('프로젝트 폴더')
  })
})
