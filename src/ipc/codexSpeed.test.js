import { describe, expect, it, vi } from 'vitest'
import { codexSpeedFooter, createCodexSpeed, hasCodexSpeedChoice } from './codexSpeed.js'

describe('Codex speed modes', () => {
  it('distinguishes the selected native command from the draft', () => {
    expect(hasCodexSpeedChoice(['› /ultrafast'], 'ultrafast')).toBe(false)
    expect(hasCodexSpeedChoice(['› /faster   another choice'], 'fast')).toBe(false)
    const screen = ['› /ultrafast   switch to faster responses', '', '› /ultrafas']
    expect(hasCodexSpeedChoice(screen, 'ultrafast')).toBe(true)
    expect(hasCodexSpeedChoice(screen, 'fast')).toBe(false)
  })

  it('reads the model and speed from the composer footer', () => {
    for (const speed of ['standard', 'fast', 'ultrafast']) {
      const label = speed === 'standard' ? '' : ` ${speed}`
      expect(codexSpeedFooter(['› ', `  gpt-6.2-sol medium${label} · ~`])).toEqual({ model: 'gpt-6.2-sol', speed })
    }
    expect(codexSpeedFooter(['  gpt-6.2-sol medium fast', '› ', '  ~'])).toBeNull()
    expect(codexSpeedFooter(['› Ask Codex to do anything', '  GPT-6.2-Sol default fast · Fast · ~'])).toEqual({ model: 'gpt-6.2-sol', speed: 'fast' })
    expect(codexSpeedFooter(['› ', '  GPT-6.2-Sol default · Standard · ~'])).toEqual({ model: 'gpt-6.2-sol', speed: 'standard' })
    expect(codexSpeedFooter(['› ', '  Ultrafast · GPT-6.2 Astra high · ~'])).toEqual({ model: 'gpt-6.2-astra', speed: 'ultrafast' })
  })

  it('toggles using the CLI confirmation and follows manual changes', async () => {
    let screen = ['› ']
    const hold = vi.fn()
    const submit = vi.fn(async () => {
      screen = ['• Service tier set to priority', '› ']
      return { ok: true }
    })
    const mode = createCodexSpeed({ lines: () => screen, submit, hold, isLive: () => true })
    expect(mode.read().speed).toBeNull()
    expect(await mode.toggle('fast')).toEqual({ ok: true })
    expect(submit).toHaveBeenCalledWith('fast')
    expect(hold.mock.calls).toEqual([[true], [false]])
    expect(mode.read().speed).toBe('fast')
    screen = ['• Service tier set to ultrafast', '› ']
    expect(mode.read()).toEqual({ speed: 'ultrafast', ultrafastAvailable: true })
    screen = ['• Service tier set to default', '› ']
    expect(mode.read().speed).toBe('standard')
  })

  it('checks the native choice again when the active model changes', async () => {
    let model = 'gpt-6.2-sol'
    const probe = vi.fn(async () => ({ ok: true, available: model === 'gpt-6.2-astra' }))
    const mode = createCodexSpeed({ lines: () => ['› ', `${model} medium`], probe, isLive: () => true })
    expect(mode.read().ultrafastAvailable).toBe(false)
    await mode.detectUltrafast()
    await mode.detectUltrafast()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(mode.read().ultrafastAvailable).toBe(false)
    model = 'gpt-6.2-astra'
    mode.read()
    await mode.detectUltrafast()
    expect(mode.read().ultrafastAvailable).toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('confirms each click from the changed footer even without a new notice', async () => {
    let active = 'Standard'
    const submit = vi.fn(async target => {
      active = active.toLowerCase() === target ? 'Standard' : target === 'fast' ? 'Fast' : 'Ultrafast'
      return { ok: true }
    })
    const mode = createCodexSpeed({
      lines: () => ['• Service tier set to default', '› ', `  GPT-6.2-Astra default · ${active} · ~`],
      submit, hold: vi.fn(), isLive: () => true
    })
    expect(mode.read().speed).toBe('standard')
    expect(await mode.toggle('fast')).toEqual({ ok: true })
    expect(mode.read().speed).toBe('fast')
    expect(await mode.toggle('fast')).toEqual({ ok: true })
    expect(mode.read().speed).toBe('standard')
    expect(await mode.toggle('ultrafast')).toEqual({ ok: true })
    expect(mode.read()).toEqual({ speed: 'ultrafast', ultrafastAvailable: true })
    expect(submit.mock.calls).toEqual([['fast'], ['fast'], ['ultrafast']])
  })

  it('requires a change in the footer speed when it was already on', async () => {
    vi.useFakeTimers()
    try {
      const mode = createCodexSpeed({
        lines: () => ['› ', '  GPT-6.2-Sol default · Fast · ~'],
        submit: async () => ({ ok: true }), hold: vi.fn(), isLive: () => true, timeout: 70
      })
      const pending = mode.toggle('fast')
      await vi.advanceTimersByTimeAsync(100)
      expect(await pending).toEqual({ ok: false, reason: 'speed-unconfirmed' })
      expect(mode.read().speed).toBe('fast')
    } finally { vi.useRealTimers() }
  })

  it('does not accept a previous CLI confirmation as an answer to a new command', async () => {
    vi.useFakeTimers()
    try {
      const mode = createCodexSpeed({
        lines: () => ['• Service tier set to priority', '› '],
        submit: async () => ({ ok: true }), hold: vi.fn(), isLive: () => true, timeout: 70
      })
      const pending = mode.toggle('fast')
      await vi.advanceTimersByTimeAsync(100)
      expect(await pending).toEqual({ ok: false, reason: 'speed-unconfirmed' })
    } finally { vi.useRealTimers() }
  })
})
