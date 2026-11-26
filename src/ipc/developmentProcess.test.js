import { expect, it, vi } from 'vitest'
import { ownsJdwpListener } from './developmentProcess.js'

it.each([
  ['win32', 'TCP 127.0.0.1:51814 0.0.0.0:0 LISTENING 42\nTCP 127.0.0.1:51814 127.0.0.1:53000 ESTABLISHED 99'],
  ['darwin', 'p42\nn127.0.0.1:51814\np99\nn127.0.0.1:51815\n']
])('allows only the selected loopback listener in the launched process tree on %s', async (platform, stdout) => {
  const run = vi.fn(async () => ({ stdout }))
  const processes = async () => new Map([[20, { parent: 1 }], [41, { parent: 20 }], [42, { parent: 41 }], [99, { parent: 1 }]])
  const options = { platform, run, processes }
  expect(await ownsJdwpListener({ port: 51814, pid: 20 }, options)).toBe(true)
  expect(await ownsJdwpListener({ port: 51814, pid: 99 }, options)).toBe(false)
  expect(await ownsJdwpListener({ port: 51816, pid: 20 }, options)).toBe(false)
  expect(await ownsJdwpListener({ port: 51814, pid: 20, signal: AbortSignal.abort() }, options)).toBe(false)
  expect(run).toHaveBeenCalledTimes(3)
})
