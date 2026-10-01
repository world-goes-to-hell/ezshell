import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import auditModule from './auditLog.js'

const { createAuditLog } = auditModule
const fixedNow = () => new Date('2026-10-01T01:02:03.000Z')

let dir
let filePath

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-audit-'))
  filePath = path.join(dir, 'mcp-audit.log')
})

const finish = (log, requestId) => {
  log.append({ phase: 'start', requestId, command: 'ls' })
  log.append({ phase: 'end', requestId, command: 'ls', outcome: 'executed' })
}

describe('createAuditLog', () => {
  it('appends one JSON line per entry with a timestamp', () => {
    const log = createAuditLog({ filePath, now: fixedNow })
    log.append({ phase: 'start', requestId: 'r1', command: 'ls' })
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual({ time: '2026-10-01T01:02:03.000Z', phase: 'start', requestId: 'r1', command: 'ls' })
  })

  it('returns finished requests newest first', () => {
    const log = createAuditLog({ filePath, now: fixedNow })
    finish(log, 'r1')
    finish(log, 'r2')
    expect(log.readRecent().map(entry => entry.requestId)).toEqual(['r2', 'r1'])
  })

  it('limits the number of returned entries', () => {
    const log = createAuditLog({ filePath, now: fixedNow })
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) finish(log, id)
    expect(log.readRecent(2).map(entry => entry.requestId)).toEqual(['r5', 'r4'])
  })

  it('rotates the file when it would grow past the limit', () => {
    const log = createAuditLog({ filePath, maxBytes: 200, now: fixedNow })
    for (const id of ['r1', 'r2', 'r3']) finish(log, id)
    expect(fs.existsSync(`${filePath}.1`)).toBe(true)
    expect(fs.statSync(filePath).size).toBeLessThanOrEqual(200)
  })

  it('reads across the rotated file', () => {
    const log = createAuditLog({ filePath, maxBytes: 200, now: fixedNow })
    for (const id of ['r1', 'r2', 'r3']) finish(log, id)
    expect(log.readRecent().map(entry => entry.requestId)).toContain('r2')
  })

  it('skips corrupted lines', () => {
    fs.writeFileSync(filePath, 'not json\n')
    const log = createAuditLog({ filePath, now: fixedNow })
    finish(log, 'r1')
    expect(log.readRecent().map(entry => entry.requestId)).toEqual(['r1'])
  })

  it('throws when the file cannot be written', () => {
    const log = createAuditLog({ filePath: path.join(dir, 'missing', 'x.log'), now: fixedNow })
    expect(() => log.append({ phase: 'start' })).toThrow()
  })

  it('prevents entry from overriding timestamp', () => {
    const log = createAuditLog({ filePath, now: fixedNow })
    log.append({ time: 'fake-time', phase: 'start', requestId: 'r1', command: 'ls' })
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0]).time).toBe('2026-10-01T01:02:03.000Z')
  })

  it('returns empty array when limit is zero or negative', () => {
    const log = createAuditLog({ filePath, now: fixedNow })
    finish(log, 'r1')
    finish(log, 'r2')
    expect(log.readRecent(0)).toEqual([])
    expect(log.readRecent(-5)).toEqual([])
  })
})
