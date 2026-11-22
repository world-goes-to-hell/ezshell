import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBrowserLogins, loginOrigin, parseLoginCsv } from './browserLogins.js'

let directory
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-browser-logins-')) })
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

describe('browser login storage and import', () => {
  it('normalizes origins and accepts HTTP only on loopback', () => {
    expect(loginOrigin('https://page.example:444/login?token=x')).toBe('https://page.example:444')
    expect(loginOrigin('http://127.0.0.1:8000/login')).toBe('http://127.0.0.1:8000')
    expect(loginOrigin('http://[::1]/')).toBe('http://[::1]')
    for (const url of ['file:///test', 'http://page.example', 'http://127.0.0.1.example', 'https://user@page.example']) {
      expect(loginOrigin(url)).toBeNull()
    }
  })

  it('accepts CSV with a BOM, escaped quotes, commas, empty usernames and notes on several lines', () => {
    const csv = '\ufeff"url","username","password","note"\r\n' +
      '"https://page.example/login",""," s,""ecret ","a\r\nb"\r\n' +
      '"http://insecure.example","user","pass",""'
    expect(parseLoginCsv(csv)).toEqual({ entries: [{ origin: 'https://page.example', username: '', password: ' s,"ecret ' }], skipped: 1 })
    expect(() => parseLoginCsv('url,user,secret\n')).toThrow(/CSV/)
    expect(() => parseLoginCsv('url,username,password\n"unterminated')).toThrow(/CSV/)
  })

  it('stores encrypted entries, skips duplicates on import and looks up passwords only for the same origin', async () => {
    const getPassword = () => 'master-for-the-test'
    const vault = createBrowserLogins(directory, getPassword)
    const origin = 'https://page.example'
    await vault.save(origin, 'first-user', 'first-password')
    const csv = path.join(directory, 'fixture.csv')
    fs.writeFileSync(csv, 'name,url,username,password\n' +
      `Site,${origin}/login,first-user,replacement\nSite,${origin}/login,other-user,second-password\n`)
    expect(await vault.import(csv)).toEqual({ imported: 1, skipped: 1 })
    const stored = fs.readFileSync(path.join(directory, 'browser-logins.json'), 'utf8')
    for (const value of [origin, 'first-user', 'first-password', 'second-password']) expect(stored).not.toContain(value)

    const reopened = createBrowserLogins(directory, getPassword)
    const accounts = await reopened.list()
    expect(accounts.map(item => item.username)).toEqual(['first-user', 'other-user'])
    expect(accounts[0]).not.toHaveProperty('password')
    const { id } = accounts[0]
    expect((await reopened.get(id, origin)).password).toBe('first-password')
    expect(await reopened.get(id, origin + ':444')).toBeUndefined()
    await reopened.remove(id)
    expect((await reopened.list()).map(item => item.username)).toEqual(['other-user'])
  })

  it('serializes changes and drops work queued before a lock or reset', async () => {
    const vault = createBrowserLogins(directory, () => 'test-master')
    await Promise.all([vault.save('https://one.example', 'one', 'foo'), vault.save('https://two.example', 'two', 'bar')])
    expect(await vault.list()).toHaveLength(2)
    const pending = vault.save('https://three.example', 'three', 'baz')
    vault.invalidate()
    await expect(pending).rejects.toThrow(/잠금/)
    expect(await vault.list()).toHaveLength(2)
    await vault.reset()
    expect(await vault.list()).toEqual([])
  })
})
