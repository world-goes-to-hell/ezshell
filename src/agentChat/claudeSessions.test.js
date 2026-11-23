import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { readClaudeSessions } from './claudeSessions.js'

it('reads the Windows process FILETIME separately from the later Claude session timestamp', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-claude-sessions-'))
  try {
    const directory = path.join(root, 'sessions')
    fs.mkdirSync(directory)
    const sessionId = '183a2d7a-c5d8-4d40-acd1-11c08bce7cde'
    const session = { kind: 'interactive', entrypoint: 'cli', sessionId, cwd: root, startedAt: 1795013656873 }
    const write = (pid, procStart) => fs.writeFileSync(path.join(directory, pid + '.json'), JSON.stringify({
      ...session, pid, procStart
    }))
    write(45832, 134394872491046332)
    write(45833, undefined)
    write(45834, 'invalid')
    const records = await readClaudeSessions(root)
    expect(records.map(record => record.pid).sort()).toEqual([45832, 45833])
    const recorded = records.find(record => record.pid === 45832)
    expect(recorded.startedAt).toBe(1795013656873)
    expect(recorded.processStartedAt).toBeCloseTo(1795013649104.6332, 2)
    expect(records.find(record => record.pid === 45833)).not.toHaveProperty('processStartedAt')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
