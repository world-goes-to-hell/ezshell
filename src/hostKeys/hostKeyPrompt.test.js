import { describe, it, expect, vi } from 'vitest'
import promptModule from './hostKeyPrompt.js'

const { createHostKeyPrompter } = promptModule

const info = { status: 'unknown', host: 'dev.example', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc' }

describe('createHostKeyPrompter', () => {
  it('sends the question with an id and returns the answer', async () => {
    const send = vi.fn(() => true)
    const prompter = createHostKeyPrompter({ send })
    const answer = prompter.prompt(info)
    const request = send.mock.calls[0][0]
    expect(request).toMatchObject(info)
    expect(typeof request.id).toBe('string')
    prompter.respond(request.id, 'trust')
    await expect(answer).resolves.toBe('trust')
  })

  it('treats anything but trust as a refusal', async () => {
    const send = vi.fn(() => true)
    const prompter = createHostKeyPrompter({ send })
    const answer = prompter.prompt(info)
    prompter.respond(send.mock.calls[0][0].id, 'yes please')
    await expect(answer).resolves.toBe('reject')
  })

  it('ignores answers for unknown ids', async () => {
    const send = vi.fn(() => true)
    const prompter = createHostKeyPrompter({ send, timeoutMs: 20 })
    const answer = prompter.prompt(info)
    prompter.respond('other', 'trust')
    await expect(answer).resolves.toBe('reject')
  })

  it('refuses when nobody answers in time', async () => {
    const send = vi.fn(() => true)
    const onDismiss = vi.fn()
    const prompter = createHostKeyPrompter({ send, timeoutMs: 10, onDismiss })
    await expect(prompter.prompt(info)).resolves.toBe('reject')
    expect(onDismiss).toHaveBeenCalledWith(send.mock.calls[0][0].id)
  })

  it('refuses at once when there is no window to ask in', async () => {
    const prompter = createHostKeyPrompter({ send: () => false })
    await expect(prompter.prompt(info)).resolves.toBe('reject')
  })

  it('shares one question between requests for the same server and key', async () => {
    const send = vi.fn(() => true)
    const prompter = createHostKeyPrompter({ send })
    const first = prompter.prompt(info)
    const second = prompter.prompt({ ...info })
    expect(send).toHaveBeenCalledTimes(1)
    prompter.respond(send.mock.calls[0][0].id, 'trust')
    await expect(Promise.all([first, second])).resolves.toEqual(['trust', 'trust'])
  })

  it('asks separately for a different key', () => {
    const send = vi.fn(() => true)
    const prompter = createHostKeyPrompter({ send })
    prompter.prompt(info)
    prompter.prompt({ ...info, fingerprint: 'SHA256:other' })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('refuses every open question on dismissAll', async () => {
    const send = vi.fn(() => true)
    const prompter = createHostKeyPrompter({ send })
    const answer = prompter.prompt(info)
    prompter.dismissAll()
    await expect(answer).resolves.toBe('reject')
  })
})
