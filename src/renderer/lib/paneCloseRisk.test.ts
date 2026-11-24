import { describe, expect, it } from 'vitest'
import { paneCloseMessage, paneCloseRisk } from './paneCloseRisk'

describe('paneCloseRisk', () => {
  it('lets a shell waiting at its prompt close without asking', () => {
    expect(paneCloseRisk({ alternate: false, cursorLine: 'deploy@web-01:~/app$ ' })).toBeNull()
    expect(paneCloseRisk({ alternate: false, cursorLine: '[root@dev ~]# ls -al' })).toBeNull()
    expect(paneCloseRisk({ alternate: false, cursorLine: 'PS C:\\DEV\\ezshell> ' })).toBeNull()
    expect(paneCloseRisk({ alternate: false, cursorLine: '~/src ❯ ' })).toBeNull()
  })

  it('knows the prompts of other shells, read up to the cursor', () => {
    for (const prompt of ['-bash-4.2$ ', 'sh-4.2$ ', '$ ', '/ # ', 'host% ', '~/src on main ❯ ', '❯ ', 'C:\\>', 'C:\\Users\\me>', 'PS C:\\x> '])
      expect(paneCloseRisk({ alternate: false, cursorLine: prompt }), prompt).toBeNull()
  })

  it('does not take a line that merely ends in a prompt sign for a prompt', () => {
    expect(paneCloseRisk({ alternate: false, cursorLine: 'Downloading 45%' })).toBe('명령이 실행 중인 것 같습니다')
    expect(paneCloseRisk({ alternate: false, cursorLine: 'total cost: 5$' })).toBe('명령이 실행 중인 것 같습니다')
    expect(paneCloseRisk({ alternate: false, cursorLine: 'PS C:\\x>' })).toBe('명령이 실행 중인 것 같습니다')
  })

  it('takes the prompt of an interactive program for a program running, not an idle shell', () => {
    for (const prompt of ['>>> ', '> ', 'mysql> ', 'postgres=# ', 'db=> ', '>> '])
      expect(paneCloseRisk({ alternate: false, cursorLine: prompt }), prompt).toBe('명령이 실행 중인 것 같습니다')
    expect(paneCloseRisk({ alternate: false, cursorLine: 'PS /home/me> ' })).toBeNull()
  })

  it('asks when an agent runs in the pane, even at an idle composer', () => {
    expect(paneCloseRisk({ agent: 'claude', alternate: false, cursorLine: 'PS C:\\> ' })).toBe('Claude 세션이 실행 중입니다')
    expect(paneCloseRisk({ agent: 'codex', alternate: false, cursorLine: '' })).toBe('Codex 세션이 실행 중입니다')
    expect(paneCloseRisk({ agent: 'other', alternate: false, cursorLine: '' })).toBe('에이전트 세션이 실행 중입니다')
  })

  it('asks for a full-screen program and for a command still printing', () => {
    expect(paneCloseRisk({ alternate: true, cursorLine: '' })).toBe('전체 화면 프로그램이 실행 중입니다')
    expect(paneCloseRisk({ alternate: false, cursorLine: '2026-11-24 23:50:01 INFO request served' })).toBe('명령이 실행 중인 것 같습니다')
    expect(paneCloseRisk({ alternate: false, cursorLine: '' })).toBe('명령이 실행 중인 것 같습니다')
  })

  it('words the question with the reason', () => {
    expect(paneCloseMessage('Claude 세션이 실행 중입니다')).toBe('이 칸에서 Claude 세션이 실행 중입니다. 칸을 닫으면 셸과 그 안의 프로그램이 함께 종료됩니다. 닫을까요?')
  })
})
