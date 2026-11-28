import { describe, expect, it } from 'vitest'
import { gitLoginCommand, needsGitLogin, typeWhenShellSettles } from './gitLogin'

describe('needsGitLogin', () => {
  it('knows main’s login sentence and nothing else', () => {
    expect(needsGitLogin('Git 로그인이 필요합니다. 이 PC 에 이 주소의 로그인 정보가 없거나 맞지 않습니다.')).toBe(true)
    expect(needsGitLogin('가져오기에 실패했습니다.')).toBe(false)
    expect(needsGitLogin(undefined)).toBe(false)
  })
})

describe('gitLoginCommand', () => {
  it('asks the branch’s own remote when there is no target', () => {
    expect(gitLoginCommand()).toBe('git ls-remote --heads')
  })

  it('names a remote or a plain https address as it is', () => {
    expect(gitLoginCommand('origin')).toBe('git ls-remote --heads -- origin')
    expect(gitLoginCommand('https://speciesgit.coreit.co.kr/nibr/nibr-msa/backend.git'))
      .toBe('git ls-remote --heads -- https://speciesgit.coreit.co.kr/nibr/nibr-msa/backend.git')
    expect(gitLoginCommand('  https://git.example.invalid:8443/a/b  ')).toBe('git ls-remote --heads -- https://git.example.invalid:8443/a/b')
  })

  // The command is typed into the user's shell: nothing a shell would read as more than a word goes in
  it('offers nothing for an address a shell could read as more than one word', () => {
    for (const target of [
      'https://host/a b', "https://host/a'b", 'https://host/a;calc', 'https://host/$(calc)', 'https://host/`calc`',
      'https://user:secret@host/x', 'http://host/x', 'git@host:path', '-upload-pack=calc', 'https://host/a&b', 'https://host/a|b'
    ]) expect(gitLoginCommand(target), target).toBeNull()
  })
})

describe('typeWhenShellSettles', () => {
  function shell(outputs: Array<{ backlog: string; exited?: boolean } | null>) {
    let time = 0
    const written: string[] = []
    let index = 0
    return {
      written,
      options: {
        read: async () => { const state = outputs[Math.min(index++, outputs.length - 1)]; return state && { exited: false, ...state } },
        write: (_id: string, data: string) => { written.push(data) },
        wait: async (ms: number) => { time += ms },
        now: () => time
      }
    }
  }

  it('types once the prompt has been drawn and the output stopped changing', async () => {
    const { written, options } = shell([{ backlog: '' }, { backlog: 'Windows PowerShell' }, { backlog: 'Windows PowerShell\r\nPS C:\repo> ' }])
    expect(await typeWhenShellSettles('local:1', 'git ls-remote --heads', options)).toBe(true)
    expect(written).toEqual(['git ls-remote --heads'])
  })

  it('types nothing into a shell that ended', async () => {
    const { written, options } = shell([{ backlog: '' }, { backlog: 'bye', exited: true }])
    expect(await typeWhenShellSettles('local:1', 'git ls-remote --heads', options)).toBe(false)
    expect(written).toEqual([])
  })

  it('types anyway after the limit when the shell keeps printing', async () => {
    let count = 0
    const { written, options } = shell([])
    options.read = async () => ({ backlog: 'x'.repeat(++count), exited: false })
    expect(await typeWhenShellSettles('local:1', 'cmd', { ...options, limitMs: 1000 })).toBe(true)
    expect(written).toEqual(['cmd'])
  })
})
