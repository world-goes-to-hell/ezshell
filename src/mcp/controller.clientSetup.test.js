import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseTOML, getStaticTOMLValue } from 'toml-eslint-parser'
import { parse as parseJsonc } from 'jsonc-parser'
import controllerModule from './controller.js'

const { createMcpController } = controllerModule

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'))

function setup({ setTokenEnv = vi.fn(async () => ({ status: 'set' })), env = {} } = {}) {
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
      env,
      setTokenEnv
    }
  })
  const { port, token } = controller.getStatus().config
  return { controller, homeDir, setTokenEnv, port, token }
}

describe('controller.setupClient', () => {
  it.each([
    ['codex', '.codex/config.toml', text => getStaticTOMLValue(parseTOML(text)).mcp_servers, 'bearer_token_env_var'],
    ['gemini', '.gemini/settings.json', text => JSON.parse(text).mcpServers, 'Bearer ${EZSHELL_MCP_TOKEN}'],
    ['opencode', 'opencode.jsonc', text => parseJsonc(text).mcp.servers, 'Bearer {env:EZSHELL_MCP_TOKEN}'],
    ['cursor', '.cursor/mcp.json', text => JSON.parse(text).mcpServers, 'Bearer ${env:EZSHELL_MCP_TOKEN}']
  ])('creates the project configuration for %s without storing the token', async (client, filename, servers, expected) => {
    const { controller, port, token, setTokenEnv } = setup()
    const projectDir = tempDir('mcp-setup-project-')
    const filePath = path.join(projectDir, filename)
    const request = { client, scope: 'project', projectDir, setTokenEnv: true }
    expect(await controller.setupClient(request)).toMatchObject({ client, filePath, result: 'added', tokenEnv: 'set' })
    const text = fs.readFileSync(filePath, 'utf8')
    const entry = servers(text)['ezshell-ssh-mcp']
    expect(entry.url ?? entry.httpUrl).toBe(`http://127.0.0.1:${port}/mcp`)
    if (client === 'codex') expect(entry[expected]).toBe('EZSHELL_MCP_TOKEN')
    else expect(entry.headers.Authorization).toBe(expected)
    if (client === 'opencode') expect(entry).toMatchObject({ type: 'remote', oauth: false })
    expect(text).not.toContain(token)
    expect(setTokenEnv).toHaveBeenCalledWith(token)
    expect(await controller.setupClient(request)).toMatchObject({ result: 'unchanged', backupPath: null })
  })

  it.each([
    ['codex', '.codex/config.toml', text => getStaticTOMLValue(parseTOML(text)).mcp_servers['ezshell-ssh-mcp'].http_headers],
    ['gemini', '.gemini/settings.json', text => JSON.parse(text).mcpServers['ezshell-ssh-mcp'].headers],
    ['opencode', '.config/opencode/opencode.jsonc', text => parseJsonc(text).mcp.servers['ezshell-ssh-mcp'].headers],
    ['cursor', '.cursor/mcp.json', text => JSON.parse(text).mcpServers['ezshell-ssh-mcp'].headers]
  ])('creates the user configuration for %s with the localhost credential', async (client, filename, headers) => {
    const { controller, homeDir, token, setTokenEnv } = setup()
    const filePath = path.join(homeDir, filename)
    expect(await controller.setupClient({ client, scope: 'global', setTokenEnv: true })).toMatchObject({
      client, filePath, result: 'added', tokenEnv: null
    })
    expect(headers(fs.readFileSync(filePath, 'utf8')).Authorization).toBe(`Bearer ${token}`)
    expect(setTokenEnv).not.toHaveBeenCalled()
  })

  it('replaces only the Codex registration after confirmation and backs up the original TOML', async () => {
    const codexHome = tempDir('mcp-setup-codex-home-')
    const { controller, token } = setup({ env: { CODEX_HOME: codexHome } })
    const filePath = path.join(codexHome, 'config.toml')
    const kept = '# Default model\r\nmodel = "example"\r\n\r\n[mcp_servers.other]\r\ncommand = "example" # Keep this'
    const original = '\uFEFF' + kept + '\r\n\r\n[mcp_servers."ezshell-ssh-mcp"]\r\nurl = "http://localhost:1111/mcp"\r\n' +
      '[mcp_servers."ezshell-ssh-mcp".http_headers]\r\nAuthorization = "Bearer prior-token"\r\n'
    fs.writeFileSync(filePath, original)
    const request = { client: 'codex', scope: 'global' }
    const conflict = await controller.setupClient(request)
    expect(conflict).toMatchObject({ result: 'conflict', existingUrl: 'http://localhost:1111/mcp', backupPath: null })
    expect(JSON.stringify(conflict)).not.toContain('prior-token')
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original)
    const outcome = await controller.setupClient({ ...request, overwrite: true })
    expect(outcome.result).toBe('replaced')
    expect(fs.readFileSync(outcome.backupPath, 'utf8')).toBe(original)
    const written = fs.readFileSync(filePath, 'utf8')
    expect(written.startsWith('\uFEFF' + kept)).toBe(true)
    expect(written).toContain(`Bearer ${token}`)
    expect(written).not.toContain('prior-token')
    expect(written.replaceAll('\r\n', '')).not.toContain('\n')
  })

  it('preserves OpenCode comments and adds to an existing legacy MCP map', async () => {
    const { controller } = setup()
    const projectDir = tempDir('mcp-setup-project-')
    const filePath = path.join(projectDir, 'opencode.jsonc')
    const original = '{\n  // Keep the project model\n  "model": "demo/model",\n  "mcp": {\n    "other": { "type": "local", "command": ["demo"] },\n  },\n}\n'
    fs.writeFileSync(filePath, original)
    const outcome = await controller.setupClient({ client: 'opencode', scope: 'project', projectDir })
    expect(outcome).toMatchObject({ filePath, result: 'added' })
    expect(fs.readFileSync(outcome.backupPath, 'utf8')).toBe(original)
    const written = fs.readFileSync(filePath, 'utf8')
    expect(written).toContain('// Keep the project model')
    expect(parseJsonc(written, [], { allowTrailingComma: true })).toMatchObject({
      model: 'demo/model', mcp: { other: { command: ['demo'] }, 'ezshell-ssh-mcp': { type: 'remote' } }
    })
  })

  it('keeps other servers when Codex uses an inline MCP table', async () => {
    const { controller } = setup()
    const projectDir = tempDir('mcp-setup-project-')
    const filePath = path.join(projectDir, '.codex/config.toml')
    fs.mkdirSync(path.dirname(filePath))
    fs.writeFileSync(filePath, 'mcp_servers = { other = { command = "demo" }, ezshell-ssh-mcp.url = "old" } # Keep this\n')
    expect(await controller.setupClient({ client: 'codex', scope: 'project', projectDir, overwrite: true })).toMatchObject({ result: 'replaced' })
    const written = fs.readFileSync(filePath, 'utf8')
    expect(written).toContain('# Keep this')
    expect(getStaticTOMLValue(parseTOML(written)).mcp_servers).toMatchObject({
      other: { command: 'demo' }, 'ezshell-ssh-mcp': { bearer_token_env_var: 'EZSHELL_MCP_TOKEN' }
    })
  })

  it('preserves a legacy OpenCode server named servers', async () => {
    const { controller } = setup()
    const projectDir = tempDir('mcp-setup-project-')
    const filePath = path.join(projectDir, 'opencode.json')
    fs.writeFileSync(filePath, '{"mcp":{"servers":{"type":"local","command":["demo"]}}}')
    await controller.setupClient({ client: 'opencode', scope: 'project', projectDir })
    expect(readJson(filePath).mcp).toMatchObject({
      servers: { type: 'local', command: ['demo'] }, 'ezshell-ssh-mcp': { type: 'remote' }
    })
  })

  it('refuses malformed Codex config without creating a backup or changing it', async () => {
    const { controller, homeDir } = setup()
    const filePath = path.join(homeDir, '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(filePath))
    fs.writeFileSync(filePath, '[mcp_servers\n')
    await expect(controller.setupClient({ client: 'codex', scope: 'global', overwrite: true })).rejects.toThrow('TOML')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('[mcp_servers\n')
    expect(fs.existsSync(filePath + '.ezshell-backup')).toBe(false)
  })

  it('writes a project .mcp.json that names the token variable and sets that variable', async () => {
    const { controller, setTokenEnv, port, token } = setup()
    const projectDir = tempDir('mcp-setup-project-')
    const outcome = await controller.setupClient({ scope: 'project', projectDir, setTokenEnv: true })
    const filePath = path.join(projectDir, '.mcp.json')
    expect(outcome).toMatchObject({ scope: 'project', filePath, result: 'added', tokenEnv: 'set' })
    expect(readJson(filePath).mcpServers['ezshell-ssh-mcp']).toEqual({
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
    fs.writeFileSync(path.join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers: { 'ezshell-ssh-mcp': { url: 'old' } } }))
    const conflict = await controller.setupClient({ scope: 'project', projectDir, setTokenEnv: true })
    expect(conflict).toMatchObject({ result: 'conflict', existingUrl: 'old', tokenEnv: null })
    expect(setTokenEnv).not.toHaveBeenCalled()
  })

  it('warns about a local-scope registration in ~/.claude.json that wins over the project file', async () => {
    const { controller, homeDir } = setup()
    const projectDir = tempDir('mcp-setup-project-')
    const asSaved = projectDir.replace(/\\/g, '/')
    fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({ projects: { [asSaved]: { mcpServers: { 'ezshell-ssh-mcp': { url: 'old' } } } } }))
    const outcome = await controller.setupClient({ scope: 'project', projectDir })
    expect(outcome.result).toBe('added')
    expect(outcome.shadowedProjects).toEqual([asSaved])
    expect(readJson(path.join(homeDir, '.claude.json')).projects[asSaved].mcpServers['ezshell-ssh-mcp']).toEqual({ url: 'old' })
  })

  describe('registrations under the old name (my-ssh-client)', () => {
    it('replaces the old entry of a project file instead of adding a second server', async () => {
      const { controller, port } = setup()
      const projectDir = tempDir('mcp-setup-project-')
      const filePath = path.join(projectDir, '.mcp.json')
      fs.writeFileSync(filePath, JSON.stringify({ mcpServers: { other: { url: 'keep' }, 'my-ssh-client': { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }))
      const outcome = await controller.setupClient({ scope: 'project', projectDir })
      expect(outcome).toMatchObject({ result: 'added', renamedFrom: ['my-ssh-client'], backupPath: `${filePath}.ezshell-backup` })
      expect(Object.keys(readJson(filePath).mcpServers)).toEqual(['other', 'ezshell-ssh-mcp'])
      expect(readJson(filePath).mcpServers['ezshell-ssh-mcp'].url).toBe(`http://127.0.0.1:${port}/mcp`)
      expect(readJson(`${filePath}.ezshell-backup`).mcpServers['my-ssh-client']).toBeDefined()
    })

    it('removes the old entry even when the new one is already there and correct', async () => {
      const { controller } = setup()
      const projectDir = tempDir('mcp-setup-project-')
      const filePath = path.join(projectDir, '.mcp.json')
      await controller.setupClient({ scope: 'project', projectDir })
      const withBoth = readJson(filePath)
      fs.writeFileSync(filePath, JSON.stringify({ mcpServers: { ...withBoth.mcpServers, 'my-ssh-client': { url: 'old' } } }))
      const outcome = await controller.setupClient({ scope: 'project', projectDir })
      expect(outcome.renamedFrom).toEqual(['my-ssh-client'])
      expect(Object.keys(readJson(filePath).mcpServers)).toEqual(['ezshell-ssh-mcp'])
      expect((await controller.setupClient({ scope: 'project', projectDir })).result).toBe('unchanged')
    })

    it('keeps the old entry when the new name is taken by something else and the user has not agreed to overwrite', async () => {
      const { controller } = setup()
      const projectDir = tempDir('mcp-setup-project-')
      const filePath = path.join(projectDir, '.mcp.json')
      const before = JSON.stringify({ mcpServers: { 'ezshell-ssh-mcp': { url: 'someone-else' }, 'my-ssh-client': { url: 'old' } } })
      fs.writeFileSync(filePath, before)
      const outcome = await controller.setupClient({ scope: 'project', projectDir })
      expect(outcome).toMatchObject({ result: 'conflict', renamedFrom: [] })
      expect(fs.readFileSync(filePath, 'utf8')).toBe(before)
    })

    it('replaces the old user-scope entry and names the projects that still register the old name', async () => {
      const { controller, homeDir } = setup()
      const filePath = path.join(homeDir, '.claude.json')
      fs.writeFileSync(filePath, JSON.stringify({
        mcpServers: { 'my-ssh-client': { url: 'old' } },
        projects: { 'D:/work/app': { mcpServers: { 'my-ssh-client': { url: 'old' } } }, 'D:/work/other': {} }
      }))
      const outcome = await controller.setupClient({ scope: 'global' })
      expect(outcome).toMatchObject({ result: 'added', renamedFrom: ['my-ssh-client'], legacyName: 'my-ssh-client', legacyProjects: ['D:/work/app'] })
      const saved = readJson(filePath)
      expect(Object.keys(saved.mcpServers)).toEqual(['ezshell-ssh-mcp'])
      // Per-project registrations are Claude Code's own records; they are reported, not edited
      expect(saved.projects['D:/work/app'].mcpServers['my-ssh-client']).toEqual({ url: 'old' })
    })

    it('tells a project setup that this folder is still registered under the old name', async () => {
      const { controller, homeDir } = setup()
      const projectDir = tempDir('mcp-setup-project-')
      const asSaved = projectDir.replace(/\\/g, '/')
      fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({ projects: { [asSaved]: { mcpServers: { 'my-ssh-client': { url: 'old' } } } } }))
      const outcome = await controller.setupClient({ scope: 'project', projectDir })
      expect(outcome.legacyProjects).toEqual([asSaved])
      expect(outcome.shadowedProjects).toEqual([])
    })

    it('reports nothing when there is no old registration', async () => {
      const { controller } = setup()
      const outcome = await controller.setupClient({ scope: 'project', projectDir: tempDir('mcp-setup-project-') })
      expect(outcome).toMatchObject({ renamedFrom: [], legacyProjects: [] })
    })
  })

  it('writes the token itself into ~/.claude.json for the global scope', async () => {
    const { controller, homeDir, token, setTokenEnv } = setup()
    const filePath = path.join(homeDir, '.claude.json')
    fs.writeFileSync(filePath, JSON.stringify({ numStartups: 1 }))
    const outcome = await controller.setupClient({ scope: 'global', setTokenEnv: true })
    expect(outcome).toMatchObject({ scope: 'global', filePath, result: 'added', tokenEnv: null })
    expect(readJson(filePath).mcpServers['ezshell-ssh-mcp'].headers).toEqual({ Authorization: `Bearer ${token}` })
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
