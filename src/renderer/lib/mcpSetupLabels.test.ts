import { describe, it, expect } from 'vitest'
import type { McpSetupOutcome } from '../types'
import { conflictQuestion, describeSetupOutcome } from './mcpSetupLabels'

const base: McpSetupOutcome = {
  scope: 'project',
  filePath: 'D:\\work\\app\\.mcp.json',
  result: 'added',
  backupPath: null,
  shadowedProjects: [],
  tokenEnv: 'set',
  tokenEnvError: null
}

describe('describeSetupOutcome', () => {
  it('describes a new project file with the variable set', () => {
    expect(describeSetupOutcome(base)).toEqual({
      title: '설정을 추가했습니다',
      tone: 'success',
      lines: [
        '파일: D:\\work\\app\\.mcp.json',
        '환경 변수 EZSHELL_MCP_TOKEN 을 설정했습니다. 새로 연 터미널에서 실행한 Claude Code 부터 적용됩니다.',
        'Claude Code 가 이 프로젝트에서 처음 쓸 때 서버 사용을 승인할지 묻습니다.'
      ]
    })
  })

  it('mentions the backup and a variable the user still has to set', () => {
    const view = describeSetupOutcome({ ...base, result: 'replaced', backupPath: 'D:\\work\\app\\.mcp.json.ezshell-backup', tokenEnv: null })
    expect(view.title).toBe('설정을 바꿨습니다')
    expect(view.lines).toContain('백업: D:\\work\\app\\.mcp.json.ezshell-backup')
    expect(view.lines).toContain('Claude Code 를 실행하기 전에 EZSHELL_MCP_TOKEN 환경 변수에 접속 토큰을 넣어 두세요.')
  })

  it('warns when the variable could not be set', () => {
    const failed = describeSetupOutcome({ ...base, tokenEnv: 'failed', tokenEnvError: 'access denied' })
    expect(failed.tone).toBe('warning')
    expect(failed.lines).toContain('환경 변수를 설정하지 못했습니다 (access denied). EZSHELL_MCP_TOKEN 에 접속 토큰을 직접 넣어 두세요.')
    const unsupported = describeSetupOutcome({ ...base, tokenEnv: 'unsupported' })
    expect(unsupported.lines).toContain('이 운영체제에서는 EZSHELL_MCP_TOKEN 환경 변수를 직접 설정하세요.')
  })

  it('describes the global file and older per-project registrations that win over it', () => {
    const view = describeSetupOutcome({
      ...base,
      scope: 'global',
      filePath: 'C:\\Users\\me\\.claude.json',
      result: 'unchanged',
      tokenEnv: null,
      shadowedProjects: ['D:/a', 'D:/b', 'D:/c', 'D:/d']
    })
    expect(view.title).toBe('이미 같은 설정이 있습니다')
    expect(view.tone).toBe('warning')
    expect(view.lines).toEqual([
      '파일: C:\\Users\\me\\.claude.json',
      '프로젝트 4곳에 예전 등록이 남아 있어 그 프로젝트에서는 예전 등록이 먼저 쓰입니다: D:/a, D:/b, D:/c 외 1곳',
      '지우려면 그 프로젝트 폴더에서 claude mcp remove my-ssh-client -s local 을 실행하세요.'
    ])
  })
})

describe('conflictQuestion', () => {
  it('names the file and the old address', () => {
    expect(conflictQuestion({ ...base, result: 'conflict', existingUrl: 'http://127.0.0.1:1111/mcp' }))
      .toBe("D:\\work\\app\\.mcp.json 에 이미 'my-ssh-client' 항목이 있습니다 (http://127.0.0.1:1111/mcp).\n덮어쓸까요? 원래 파일은 백업합니다.")
    expect(conflictQuestion({ ...base, result: 'conflict', existingUrl: '' })).toContain('(주소 없음)')
  })
})
