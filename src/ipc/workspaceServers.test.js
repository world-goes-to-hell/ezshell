import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createWorkspaceAccess, workspaceServers } from './workspaceServers.js'
import { workspaceVmArguments, validContextPath } from './tomcatRun.js'

let root, folder, worktree, outsiders, profile, file, project
const launches = '.metadata/.plugins/org.eclipse.debug.core/.launches'
const context = (value = 'fixture-secret') => `<Context path="/ignored"><Resource name="jdbc/Test" password="${value}"/><Environment name="mode" value="qa"/><Parameter name="mode" value="qa"/><Valve className="ignore"/></Context>`

async function write(base, relative, contents) {
  const file = path.join(base, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, contents)
  return file
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ezshell-workspace-'))
  folder = path.join(root, 'Eclipse QA')
  worktree = path.join(root, 'worktree')
  outsiders = path.join(root, 'outside')
  profile = path.join(root, 'profile')
  await Promise.all([folder, worktree, outsiders, profile].map(directory => fs.mkdir(directory)))
  file = path.join(profile, 'grants.json')
  project = { key: 'fixture project', worktree }
})
afterEach(async () => fs.rm(root, { recursive: true, force: true }))

describe('Eclipse workspace server settings', () => {
  it('imports multiple servers and matching launch flags while leaving settings and secrets out of drafts', async () => {
    const alpha = 'Servers/Tomcat alpha-config'
    await write(folder, `${alpha}/server.xml`, '<Server port="8005"><Service><Connector protocol="AJP/1.3" port="8009"/><Connector protocol="HTTP/1.1" port="8091"/><Engine><Host><Context path="/alpha"/></Host></Engine></Service></Server>')
    const contextXml = await write(folder, `${alpha}/context.xml`, context())
    await write(folder, 'Servers/Tomcat beta-config/server.xml', '<Server><Service><Connector port="8092"/></Service></Server>')
    await write(folder, `${launches}/Tomcat alpha.launch`, '<launchConfiguration><stringAttribute key="org.eclipse.jdt.launching.VM_ARGUMENTS" value="-Xmx512m&#10;-Dexample=&quot;two words&quot; -Dcatalina.base=elsewhere -Ddatabase.password=hidden -Ddb.pw=hidden -Djdbc.pwd=hidden"/></launchConfiguration>')
    const result = await workspaceServers(folder, { launchArguments: workspaceVmArguments, validContextPath })
    expect(result.servers).toEqual([{ name: 'Tomcat alpha', port: 8091, contextPath: '/alpha', contextXml, vmArgs: '-Xmx512m "-Dexample=two words"' },
      { name: 'Tomcat beta', port: 8092 }])
    expect(JSON.stringify(result)).not.toMatch(/hidden|fixture-secret|elsewhere/)
    expect(result.notes).toContain('자격 증명으로 보이는 VM 인자 3개를 건너뛰었습니다.')
  })

  it('bounds reads and rejects declarations, untrusted roots and link escapes', async () => {
    const external = await write(folder, 'Servers/Tomcat-config/context.xml', context())
    const outside = await write(outsiders, 'context.xml', context())
    await fs.symlink(outsiders, path.join(folder, 'Servers', 'Escape-config'), process.platform === 'win32' ? 'junction' : 'dir')
    await write(folder, 'Servers/Too big-config/server.xml', Buffer.alloc(256 * 1024 + 1, 32))
    const access = createWorkspaceAccess(file)
    await expect(access.contextFile(project, external)).rejects.toThrow('직접 선택')
    access.grant(project, await access.selectedRoot(folder))
    const reloaded = createWorkspaceAccess(file)
    await expect(reloaded.contextFile({ ...project, key: 'other project' }, external)).rejects.toThrow('직접 선택')
    await expect(reloaded.contextFile(project, outside)).rejects.toThrow('직접 선택')
    await expect(reloaded.contextFile(project, path.join(folder, 'Servers', 'Escape-config', 'context.xml'))).rejects.toThrow('직접 선택')
    expect((await reloaded.contextEntries(project, external)).map(node => node.name)).toEqual(['Resource', 'Environment', 'Parameter'])
    expect((await workspaceServers(folder, { launchArguments: workspaceVmArguments, validContextPath })).notes).toContain('이클립스 XML을 읽지 못했습니다. server.xml')
    await write(folder, 'Servers/Tomcat-config/context.xml', '<!DOCTYPE Context SYSTEM "http://example.invalid/context"><Context/>')
    await expect(reloaded.contextEntries(project, external)).rejects.toThrow('컨텍스트 XML을 읽을 수 없거나')
  })

  it('stores worktree files relative to the worktree', async () => {
    const selected = await write(worktree, 'src/META-INF/context.xml', context())
    const access = createWorkspaceAccess(file)
    expect(await access.contextFile(project, selected)).toEqual({ file: selected, reference: 'src/META-INF/context.xml' })
  })

  it('rejects an opened XML handle with a different file identity', async () => {
    const selected = await write(worktree, 'context.xml', context())
    const unrelated = await write(outsiders, 'context.xml', context('fixture-other-file'))
    const open = vi.spyOn(fs, 'open').mockResolvedValueOnce(await fs.open(unrelated, 'r'))
    try {
      await expect(createWorkspaceAccess(file).contextEntries(project, selected)).rejects.toThrow('컨텍스트 XML을 읽을 수 없거나')
    } finally { open.mockRestore() }
  })
})
