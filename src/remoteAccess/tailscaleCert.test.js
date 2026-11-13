import { describe, it, expect, vi } from 'vitest'
import tailscaleCert from './tailscaleCert.js'

const { tailnetName, ensureCertificate, isGoodFor } = tailscaleCert

const statusOf = (self, certDomains) => async () => JSON.stringify({ Self: { DNSName: self }, CertDomains: certDomains })

describe('tailnetName', () => {
  it('reads this PC\'s name and whether a certificate can be had', async () => {
    expect(await tailnetName({ run: statusOf('My-PC.tail1234.ts.net.', ['my-pc.tail1234.ts.net']) })).toEqual({ name: 'my-pc.tail1234.ts.net', canCertify: true })
    expect(await tailnetName({ run: statusOf('my-pc.tail1234.ts.net.', []) })).toEqual({ name: 'my-pc.tail1234.ts.net', canCertify: false })
    expect(await tailnetName({ run: statusOf('my-pc.tail1234.ts.net.', null) })).toEqual({ name: 'my-pc.tail1234.ts.net', canCertify: false })
  })

  it('takes nothing that is not a tailnet name', async () => {
    for (const name of ['', 'my-pc', 'evil.example.com.', 'pc.ts.net --cert-file x', '-x.ts.net; rm', '-x.ts.net', '--key-file.ts.net', 'pc.-x.ts.net']) {
      expect(await tailnetName({ run: statusOf(name, [name]) }), name).toEqual({ name: null, canCertify: false })
    }
  })

  it('fails when Tailscale cannot be asked', async () => {
    await expect(tailnetName({ run: async () => { throw new Error('not running') } })).rejects.toThrow()
    await expect(tailnetName({ run: async () => 'not json' })).rejects.toThrow()
  })
})

describe('ensureCertificate', () => {
  const name = 'my-pc.tail1234.ts.net'

  it('asks Tailscale when there is no certificate, with the name as a single argument', async () => {
    const run = vi.fn(async () => '')
    const fileSystem = { readFileSync: () => { throw new Error('ENOENT') } }
    // Nothing usable comes out of the stub: the point is what was asked
    await expect(ensureCertificate({ dir: 'C:/data', name, run, fileSystem })).rejects.toThrow()
    expect(run).toHaveBeenCalledTimes(1)
    const [args] = run.mock.calls[0]
    expect(args[0]).toBe('cert')
    expect(args[args.length - 1]).toBe(name)
    // After "--": whatever the name is, it is not read as an option
    expect(args[args.length - 2]).toBe('--')
    expect(args).toContain('--cert-file')
    expect(args).toContain('--key-file')
  })

  it('refuses a name that is not a tailnet name before running anything', async () => {
    const run = vi.fn()
    await expect(ensureCertificate({ dir: 'C:/data', name: 'x.ts.net --key-file C:/evil', run })).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })

  it('does not take a file that is not a certificate for the name', () => {
    expect(isGoodFor('not a certificate', name, Date.now(), 0)).toBe(false)
    expect(isGoodFor('', name, Date.now(), 0)).toBe(false)
  })
})
