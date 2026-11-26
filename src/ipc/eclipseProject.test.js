import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadEclipseProject } from './eclipseProject.js'
import { buildEclipse } from './eclipseBuild.js'
import { createJavac } from './hotReloadJava.js'

let fixture, worktree, cwd, profile
const id = 'c36107ca-684c-4285-b45b-4ca225ae73a8'
const settings = '.settings'
const write = (name, value) => fs.writeFile(path.join(cwd, name), value)

beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ezshell-eclipse-unit-'))
  worktree = path.join(fixture, 'worktree')
  cwd = path.join(worktree, 'web-project')
  profile = path.join(fixture, 'profile')
  await Promise.all([profile, path.join(cwd, settings), path.join(cwd, 'src'), path.join(cwd, 'src', 'test'),
    path.join(cwd, 'Web & Pages', 'WEB-INF'), path.join(worktree, 'shared'), path.join(fixture, 'outside')]
    .map(folder => fs.mkdir(folder, { recursive: true })))
  await Promise.all([
    write('.classpath', '<classpath><classpathentry kind="src" path="src"/><classpathentry kind="src" path="src/test"/>' +
      '<classpathentry kind="src" path="escape"/><classpathentry kind="src" path="/OtherProject"/>' +
      '<classpathentry kind="lib" path="../shared/fixture.jar"/><classpathentry kind="lib" path="../../outside/fixture.jar"/>' +
      '<classpathentry kind="con" path="org.eclipse.jdt.USER_LIBRARY/Hidden"/></classpath>'),
    write(`${settings}/org.eclipse.wst.common.component`, '<project-modules><wb-module><wb-resource deploy-path="/" source-path="/Web &amp; Pages"/>' +
      '<property name="context-root" value="fixture"/></wb-module></project-modules>'),
    write(`${settings}/org.eclipse.wst.common.project.facet.core.xml`, '<faceted-project><installed facet="java" version="1.8"/><installed facet="jst.web" version="3.0"/></faceted-project>'),
    fs.writeFile(path.join(worktree, 'shared', 'fixture.jar'), 'fixture'),
    fs.writeFile(path.join(fixture, 'outside', 'fixture.jar'), 'outside'),
    fs.symlink(path.join(fixture, 'outside'), path.join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  ])
})
afterEach(async () => fs.rm(fixture, { recursive: true, force: true }))

describe('Eclipse project settings', () => {
  it('reads WTP, prefs and relative classpath entries within the worktree', async () => {
    const fallback = await loadEclipseProject(worktree, cwd)
    expect(fallback.draft).toEqual({ webapp: 'Web & Pages', contextPath: '/fixture', release: 8,
      encoding: 'MS949', sources: ['src'], libs: ['../shared/fixture.jar'] })
    expect(fallback.notes).toEqual(expect.arrayContaining([expect.stringContaining('Tomcat 7'), expect.stringContaining('MS949')]))
    expect(fallback.notes).toEqual(expect.arrayContaining([expect.stringContaining('라이브러리 1개'), expect.stringContaining('org.eclipse.jdt.USER_LIBRARY')]))
    expect(fallback.notes.join('\n')).not.toContain('../../outside')
    await write(`${settings}/org.eclipse.core.resources.prefs`, 'eclipse.preferences.version=1\r\nencoding/<project>=UTF-8\r\n')
    await write(`${settings}/org.eclipse.jdt.core.prefs`, 'org.eclipse.jdt.core.compiler.compliance=17\r\n')
    expect((await loadEclipseProject(worktree, cwd)).draft).toMatchObject({ release: 17, encoding: 'UTF-8' })
  })

  it('refuses oversized XML and declarations in settings', async () => {
    await write('.classpath', '<!DOCTYPE classpath SYSTEM "file:///outside"><classpath/>')
    await expect(loadEclipseProject(worktree, cwd)).rejects.toThrow('.classpath')
    await write('.classpath', Buffer.alloc(256 * 1024 + 1, 32))
    await expect(loadEclipseProject(worktree, cwd)).rejects.toThrow('너무 큽니다')
  })
})

describe('Eclipse startup build', () => {
  it('passes the isolated output directory and ten-minute timeout to javac for a large build', async () => {
    const output = path.join(profile, 'output')
    await fs.mkdir(output)
    const readClassInfo = vi.fn()
    const run = vi.fn(async (_executable, args, options) => {
      if (args[0] === '-version') return { stdout: 'javac 17.0.1', stderr: '' }
      expect(options.timeout).toBe(600_000)
      const argumentsText = await fs.readFile(args[1].slice(1), 'utf8')
      expect(argumentsText).toContain(`"-d"\n"${output.replaceAll('\\', '\\\\')}"`)
      for (let start = 0; start < 2049; start += 64) {
        await Promise.all(Array.from({ length: Math.min(64, 2049 - start) }, (_, index) => fs.writeFile(path.join(output, `C${start + index}.class`), 'fixture')))
      }
      return { stdout: '', stderr: '' }
    })
    const compile = createJavac({ env: {}, signal: new AbortController().signal, readClassInfo, run, tempRoot: profile, isolatedOutput: true })
    await expect(compile({ root: { output, moduleRoot: cwd, compilerOptions: { encoding: 'MS949', release: 8, noProcessors: true } },
      sources: [path.join(cwd, 'src', 'Fixture.java')], classpath: [output] })).resolves.toEqual([])
    expect(await fs.readdir(output)).toHaveLength(2049)
    expect(readClassInfo).not.toHaveBeenCalled()
  })

  it('compiles only changed Java, copies/removes resources and preserves the last successful snapshot on error', async () => {
    const a = path.join(cwd, 'src', 'One.java')
    const b = path.join(cwd, 'src', 'Two.java')
    await Promise.all([fs.writeFile(a, 'one'), fs.writeFile(b, 'two'), write('src/message.properties', 'checked=yes'), write('src/test/FixtureTest.java', 'test')])
    const eclipse = await loadEclipseProject(worktree, cwd)
    const compile = vi.fn(async ({ root }) => fs.writeFile(path.join(root.output, 'compiled'), 'ok'))
    const options = { eclipse, libs: eclipse.libs, userData: profile, id, worktreeKey: worktree, worktree, cwd,
      env: { PATH: 'fixture', JDK_JAVAC_OPTIONS: '-d unsafe' }, signal: new AbortController().signal,
      log: vi.fn(), makeCompiler: vi.fn(() => compile) }
    const { output, layout } = await buildEclipse(options)
    expect(layout.roots[0]).toMatchObject({ output, compilerOptions: { encoding: 'MS949', release: 8, noProcessors: true } })
    expect(await fs.readFile(path.join(output, 'message.properties'), 'utf8')).toBe('checked=yes')
    expect(compile.mock.calls[0][0].sources).toEqual([a, b])
    expect(options.makeCompiler.mock.calls[0][0].env).toEqual({ PATH: 'fixture' })
    await buildEclipse(options)
    expect(compile).toHaveBeenCalledTimes(1)
    await fs.writeFile(a, 'one changed')
    await fs.unlink(path.join(cwd, 'src', 'message.properties'))
    compile.mockRejectedValueOnce(new Error('compile failed'))
    await expect(buildEclipse(options)).rejects.toThrow('compile failed')
    expect(await fs.readFile(path.join(output, 'message.properties'), 'utf8')).toBe('checked=yes')
    await buildEclipse(options)
    expect(compile.mock.calls.at(-1)[0].sources).toEqual([a])
    await expect(fs.stat(path.join(output, 'message.properties'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(cwd, 'Web & Pages', 'WEB-INF', 'classes'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
