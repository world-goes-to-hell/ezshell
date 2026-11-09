import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { pollTail, startTail, MESSAGES } = require('./logTail.js')
const { createFakeSftp } = require('../mcp/fakeSftp.testhelper.js')

const LOG = '/var/log/app.log'
const file = (data) => ({ type: 'file', data })

function setup(initial, tree = {}) {
  const sftp = createFakeSftp({ '/var': { type: 'dir' }, '/var/log': { type: 'dir' }, [LOG]: file(initial), ...tree })
  const write = (data, target = LOG) => sftp.tree.set(target, file(data))
  const append = (data, target = LOG) => write(Buffer.concat([Buffer.from(sftp.tree.get(target).data), Buffer.from(data)]), target)
  const reads = () => sftp.calls.filter(call => call[0] === 'read').length
  const opens = () => sftp.calls.filter(call => call[0] === 'open').length
  return { sftp, write, append, reads, opens }
}

const start = (text, path = LOG) => startTail({ requestedPath: path, path, size: Buffer.byteLength(text) })

describe('log tail', () => {
  it('reads nothing while the file stays the same size', async () => {
    const { sftp, reads, opens } = setup('a\n')
    // The first look also notes how the file starts (to tell a new file of the same name later)
    const first = await pollTail(sftp, start('a\n'))
    expect(first.result).toEqual({ status: 'same' })
    const before = { reads: reads(), opens: opens(), calls: sftp.calls.length }
    const second = await pollTail(sftp, first.state)
    expect(second.result).toEqual({ status: 'same' })
    expect({ reads: reads(), opens: opens() }).toEqual({ reads: before.reads, opens: before.opens })
    expect(sftp.calls.slice(before.calls).map(call => call[0])).toEqual(['stat'])
  })

  it('sends only what was added, and closes the file after each read', async () => {
    const { sftp, append } = setup('a\n')
    let state = start('a\n')
    append('b\nc\n')
    let polled = await pollTail(sftp, state)
    expect(polled.result).toEqual({ status: 'append', text: 'b\nc\n' })
    state = polled.state
    append('d\n')
    polled = await pollTail(sftp, state)
    expect(polled.result).toEqual({ status: 'append', text: 'd\n' })
    expect(sftp.openHandles()).toBe(0)
  })

  it('holds a line until it ends, and never splits a character', async () => {
    const { sftp, append } = setup('')
    let state = start('')
    const line = Buffer.from('한글 줄\n')
    append(line.subarray(0, 4))
    let polled = await pollTail(sftp, state)
    expect(polled.result).toEqual({ status: 'same' })
    append(line.subarray(4))
    polled = await pollTail(sftp, polled.state)
    expect(polled.result).toEqual({ status: 'append', text: '한글 줄\n' })
  })

  it('sends a very long unfinished line rather than holding it forever', async () => {
    const { sftp, append } = setup('')
    append('x'.repeat(40))
    const polled = await pollTail(sftp, start(''), { maxPendingBytes: 16 })
    expect(polled.result).toEqual({ status: 'append', text: 'x'.repeat(40) })
  })

  it('skips what is beyond the limit of one read, starting at a whole line', async () => {
    const { sftp, append } = setup('a\n')
    append('1111\n2222\n3333\n')
    const polled = await pollTail(sftp, start('a\n'), { maxBytes: 8 })
    expect(polled.result).toEqual({ status: 'skipped', skippedBytes: 10, text: '3333\n' })
  })

  it('starts over when the file got shorter (copytruncate)', async () => {
    const { sftp, write } = setup('old line\n')
    write('new\n')
    const polled = await pollTail(sftp, start('old line\n'))
    expect(polled.result).toEqual({ status: 'rotated', text: 'new\n' })
  })

  it('starts over when the start of the file changed (a new file of the same name)', async () => {
    const { sftp, write, append } = setup('2026-11-05 first\n')
    let polled = await pollTail(sftp, start('2026-11-05 first\n'))
    append('second\n')
    polled = await pollTail(sftp, polled.state)
    expect(polled.result.status).toBe('append')
    write('2026-11-06 other start, longer than before\n')
    polled = await pollTail(sftp, polled.state)
    expect(polled.result).toEqual({ status: 'rotated', text: '2026-11-06 other start, longer than before\n' })
  })

  it('starts over when the link points at another file', async () => {
    const tree = { '/var/log/app-1.log': file('one\n'), '/var/log/app-2.log': file('two lines\nmore\n'), '/var/log/current': { type: 'link', target: '/var/log/app-1.log' } }
    const { sftp } = setup('', tree)
    const state = startTail({ requestedPath: '/var/log/current', path: '/var/log/app-1.log', size: 4 })
    sftp.tree.set('/var/log/current', { type: 'link', target: '/var/log/app-2.log' })
    const polled = await pollTail(sftp, state)
    expect(polled.result).toEqual({ status: 'rotated', text: 'two lines\nmore\n' })
  })

  it('waits while the file is missing (renamed away, not made again yet)', async () => {
    const { sftp, write } = setup('a\n')
    sftp.tree.delete(LOG)
    let polled = await pollTail(sftp, start('a\n'))
    expect(polled.result).toEqual({ status: 'missing' })
    write('b\n')
    polled = await pollTail(sftp, polled.state)
    expect(polled.result).toEqual({ status: 'rotated', text: 'b\n' })
  })

  it('refuses when the link now points into a system folder', async () => {
    const tree = { '/var/log/current': { type: 'link', target: '/var/log/app.log' }, '/proc': { type: 'dir' }, '/proc/kmsg': file('kernel\nlines\n') }
    const { sftp } = setup('a\n', tree)
    const state = startTail({ requestedPath: '/var/log/current', path: LOG, size: 2 })
    sftp.tree.set('/var/log/current', { type: 'link', target: '/proc/kmsg' })
    await expect(pollTail(sftp, state)).rejects.toMatchObject({ userMessage: MESSAGES.system })
  })

  it('drops NUL bytes (the empty part copytruncate can leave)', async () => {
    const { sftp, append } = setup('a\n')
    append(Buffer.concat([Buffer.alloc(6), Buffer.from('after\n')]))
    const polled = await pollTail(sftp, start('a\n'))
    expect(polled.result).toEqual({ status: 'append', text: 'after\n' })
  })

  it('keeps the state it was given (a new one comes back)', async () => {
    const { sftp, append } = setup('a\n')
    const state = start('a\n')
    const copy = { ...state }
    append('b\n')
    await pollTail(sftp, state)
    expect(state).toEqual(copy)
  })
})
