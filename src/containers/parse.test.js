import { describe, it, expect } from 'vitest'
import { listCommand, readList, readContainerLine, isContainerName, NO_DOCKER_MARK, MAX_CONTAINERS } from './parse.js'

const row = (extra = {}) => JSON.stringify({
  ID: 'a1b2c3d4e5f6', Names: 'web', Image: 'nginx:1.27', Status: 'Up 3 days', State: 'running',
  Ports: '0.0.0.0:8080->80/tcp', Command: '"/docker-entrypoint.…"', ...extra
})

describe('container list', () => {
  it('asks with a time limit and only adds -a when asked', () => {
    expect(listCommand()).toContain('timeout 5 docker ps --format')
    expect(listCommand({ all: true })).toContain('timeout 5 docker ps -a --format')
    expect(listCommand()).toContain(NO_DOCKER_MARK)
  })

  it('reads the rows and keeps only the fields the panel shows', () => {
    const result = readList({ stdout: `${row()}\n${row({ Names: 'db', Image: 'postgres:16', Ports: '' })}\n`, exitCode: 0 })
    expect(result).toEqual({
      kind: 'list',
      truncated: false,
      containers: [
        { id: 'a1b2c3d4e5f6', name: 'web', image: 'nginx:1.27', status: 'Up 3 days', state: 'running', ports: '0.0.0.0:8080->80/tcp' },
        { id: 'a1b2c3d4e5f6', name: 'db', image: 'postgres:16', status: 'Up 3 days', state: 'running', ports: '' }
      ]
    })
  })

  it('skips lines that are not container rows', () => {
    const result = readList({ stdout: `WARNING: something\n${row()}\n{"Names": 5}\n[]\n`, exitCode: 0 })
    expect(result.containers.map(c => c.name)).toEqual(['web'])
  })

  it('takes the first of several names and drops a name that could not go into a command line', () => {
    expect(readContainerLine(row({ Names: 'web,other/web' })).name).toBe('web')
    expect(readContainerLine(row({ Names: 'web; rm -rf /' }))).toBeNull()
    expect(readContainerLine(row({ Names: '$(reboot)' }))).toBeNull()
  })

  it('tells "no docker", "no permission" and a slow daemon apart from other failures', () => {
    expect(readList({ stdout: `${NO_DOCKER_MARK}\n`, exitCode: 0 })).toEqual({ kind: 'no-docker' })
    expect(readList({ stderr: 'permission denied while trying to connect to the Docker daemon socket', exitCode: 1 })).toEqual({ kind: 'no-permission' })
    expect(readList({ exitCode: 124 })).toEqual({ kind: 'error', message: '도커가 5초 안에 응답하지 않았습니다.' })
    expect(readList({ stderr: '\nCannot connect to the Docker daemon. Is it running?\nmore', exitCode: 1 }))
      .toEqual({ kind: 'error', message: 'Cannot connect to the Docker daemon. Is it running?' })
    expect(readList({ exitCode: 1 }).message).toBe('컨테이너 목록을 읽지 못했습니다.')
  })

  it('caps the list', () => {
    const many = Array.from({ length: MAX_CONTAINERS + 5 }, (_, i) => row({ Names: `c${i}` })).join('\n')
    const result = readList({ stdout: many, exitCode: 0 })
    expect(result.containers).toHaveLength(MAX_CONTAINERS)
    expect(result.truncated).toBe(true)
  })

  it('cuts overlong fields', () => {
    expect(readContainerLine(row({ Ports: 'x'.repeat(1000) })).ports).toHaveLength(300)
  })
})

describe('isContainerName', () => {
  it('accepts docker names and ids only', () => {
    for (const name of ['web', 'my_app-1', 'a1b2c3d4e5f6', 'svc.1.abc']) expect(isContainerName(name)).toBe(true)
    for (const name of ['', '-web', '.web', 'web app', 'web;ls', 'web`id`', "web'", 'a'.repeat(129), null, 5]) expect(isContainerName(name)).toBe(false)
  })
})
