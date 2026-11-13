import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { readTabbyText } = require('./tabby.js')
const { readSshConfigText, parseJump } = require('./sshConfig.js')

const tabbyYaml = `version: 7
profiles:
  - type: local
    name: shell
  - type: ssh
    name: '[개발] E-Science'
    id: ssh:abc
    group: g1
    options:
      host: 10.0.0.10
      port: 2222
      user: dev
      auth: publicKey
      privateKeys:
        - file://C:\\keys\\dev.pem
      jumpHost: ssh:bastion
  - type: ssh
    name: bastion
    id: ssh:bastion
    group: old group name
    options:
      host: bastion.example.com
      user: jump
      auth: password
  - type: ssh
    name: no host
    options: {}
groups:
  - id: g1
    name: 개발
`

describe('tabby', () => {
  it('reads SSH profiles with their group, key file and jump profile', () => {
    const result = readTabbyText(tabbyYaml)
    expect(result.folders.map(f => f.name)).toEqual(['개발', 'old group name'])
    expect(result.sessions[0]).toMatchObject({
      name: '[개발] E-Science', host: '10.0.0.10', port: 2222, username: 'dev', folderId: 'f1',
      authType: 'privateKey', privateKeyPath: 'C:\\keys\\dev.pem', jump: { host: 'bastion.example.com', port: 22, username: 'jump' }
    })
    expect(result.sessions[1]).toMatchObject({ name: 'bastion', folderId: 'f2', authType: 'password', hasSavedPassword: null })
    expect(result.skipped).toEqual({ 'local 프로필': 1, '호스트 없음': 1 })
  })

  it('refuses YAML with custom types and broken files', () => {
    expect(() => readTabbyText('profiles: !!js/function "function(){}"')).toThrow()
    expect(() => readTabbyText('profiles: [')).toThrow()
  })
})

describe('ssh config', () => {
  const config = `
# defaults
Host *
  User defaultuser
  ServerAliveInterval 30

Host web web-alias
  HostName 10.0.0.5
  Port 2200
  IdentityFile ~/.ssh/id_web
  ProxyJump bastion

Host bastion
  HostName bastion.example.com
  User jump

Host db
  HostName db.internal
  User dba
  ProxyJump ops@[fd00::1]:2222

Host *.prod !skip
  User nobody

Match host x
  User y
`

  it('makes a session per concrete Host name with defaults and resolved jump hosts', () => {
    const result = readSshConfigText(config, { home: '/home/me' })
    expect(result.sessions.map(s => s.name)).toEqual(['web', 'web-alias', 'bastion', 'db'])
    expect(result.sessions[0]).toMatchObject({
      host: '10.0.0.5', port: 2200, username: 'defaultuser', privateKeyPath: '/home/me/.ssh/id_web', authType: 'privateKey',
      jump: { host: 'bastion.example.com', port: 22, username: 'jump' }
    })
    expect(result.sessions[3]).toMatchObject({ host: 'db.internal', username: 'dba', jump: { host: 'fd00::1', port: 2222, username: 'ops' } })
    expect(result.skipped).toEqual({ '패턴 Host': 2, 'Match 블록': 1 })
  })

  it('parses ProxyJump hops', () => {
    expect(parseJump('a@b:22,c')).toEqual({ username: 'a', host: 'b', port: '22' })
    expect(parseJump('none')).toBeNull()
  })
})
