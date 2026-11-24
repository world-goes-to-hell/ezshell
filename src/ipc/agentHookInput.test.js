import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { readHookInput } from './agentHookInput.js'

describe('hook stdin', () => {
  it('drains a large message and saves only named root fields, even across chunk boundaries', async () => {
    let written = 0
    function* chunks() {
      yield '{"last_assistant_message":"'
      const page = 'discarded output '.repeat(4096)
      for (let index = 0; index < 70; index++) {
        written += page.length
        yield page
      }
      yield '","tool_input":{"hook_event_name":"SessionEnd","tool_use_id":"other","nested":[null,{},1.5e-7]},'
      yield '"hook_event_'
      yield 'name":"St\\u00'
      yield '6fp","tool_name":"' + 'x'.repeat(101) + '","stop_hook_active":tr'
      yield 'ue,"prompt":"/private/path"}'
    }
    const result = await readHookInput(Readable.from(chunks()))
    expect(written).toBeGreaterThan(4 * 1024 * 1024)
    expect(result).toEqual({ complete: true, fields: { hook_event_name: 'Stop', stop_hook_active: true } })
  })

  it.each([
    '{"hook_event_name":"Stop","bad":[1,]}',
    '{"hook_event_name":"Stop","bad":01}',
    '{"hook_event_name":"Stop","bad":"\\u03kk"}',
    '{"hook_event_name":"Stop"} {}',
    '{"hook_event_name":"Stop","prompt":"short'
  ])('does not return fields for broken JSON', async raw => {
    expect(await readHookInput(Readable.from([raw]))).toBeNull()
  })

  it('finishes a complete object without waiting for EOF and discards the subagent id', async () => {
    const input = new PassThrough()
    const read = readHookInput(input, 1000)
    input.write('{"hook_event_name":"PermissionRequest","agent_id":"private-child"}')
    expect(await read).toEqual({ complete: true, fields: { hook_event_name: 'PermissionRequest' }, subagent: true })
    const drained = new Promise(resolve => input.once('end', resolve))
    input.end(' ')
    await drained
  })

  it('returns known fields on timeout and drains remaining input', async () => {
    const input = new PassThrough()
    const read = readHookInput(input, 20)
    input.write('{"hook_event_name":"Stop","last_assistant_message":"')
    expect(await read).toEqual({ complete: false, fields: { hook_event_name: 'Stop' } })
    const drained = new Promise(resolve => input.once('end', resolve))
    input.end('more output"}')
    await drained
  })
})
