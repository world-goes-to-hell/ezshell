import { describe, it, expect } from 'vitest'
import { isCandidateFile, isValidName, definitionsIn, placeholderAt } from './configRefs.js'

const lines = (hits) => hits.map(hit => hit.line)

describe('isCandidateFile', () => {
  it('takes the files that can set values', () => {
    for (const name of ['.env', '.env.prod', 'app.env', 'Dockerfile', 'Dockerfile.dev', 'docker-compose.yml', 'application-prod.yaml', 'app.properties', 'run.sh', 'app.service', 'nginx.conf']) {
      expect(isCandidateFile(name)).toBe(true)
    }
    for (const name of ['README.md', 'main.ts', 'pom.xml']) expect(isCandidateFile(name)).toBe(false)
  })
})

describe('isValidName', () => {
  it('takes env and property names only', () => {
    expect(isValidName('UPLOAD_DIR')).toBe(true)
    expect(isValidName('app.upload.dir')).toBe(true)
    expect(isValidName('servers[0].host')).toBe(true)
    expect(isValidName('../etc')).toBe(false)
    expect(isValidName('a b')).toBe(false)
  })
})

describe('definitionsIn', () => {
  it('reads .env lines, skipping comments and other names', () => {
    const text = '# UPLOAD_DIR=/old\nUPLOAD_DIR=/data/uploads\nUPLOAD_DIRS=/x\nexport UPLOAD_DIR="/srv"\n'
    expect(definitionsIn('.env', text, 'UPLOAD_DIR')).toEqual([
      { line: 2, text: 'UPLOAD_DIR=/data/uploads' },
      { line: 4, text: 'export UPLOAD_DIR="/srv"' }
    ])
  })

  it('reads both environment forms of a compose file', () => {
    const text = [
      'services:',
      '  app:',
      '    environment:',
      '      UPLOAD_DIR: /data/uploads',
      '  worker:',
      '    environment:',
      '      - UPLOAD_DIR=/data/worker',
      '      - OTHER=1'
    ].join('\n')
    expect(lines(definitionsIn('docker-compose.yml', text, 'UPLOAD_DIR'))).toEqual([4, 7])
  })

  it('follows the indentation path of a dotted name and Spring relaxed names', () => {
    const text = ['app:', '  upload:', '    dir: ${UPLOAD_DIR:./uploads}', 'other:', '  dir: x'].join('\n')
    expect(lines(definitionsIn('application.yml', text, 'app.upload.dir'))).toEqual([3])
    expect(definitionsIn('application.yml', text, 'UPLOAD_DIR')).toEqual([])
    const props = 'app.upload.dir=/a\napp.upload-dir=/b\n# app.upload.dir=/c\n'
    expect(lines(definitionsIn('app.properties', props, 'app.upload.dir'))).toEqual([1, 2])
  })

  it('reads ENV and ARG in a Dockerfile', () => {
    const text = 'FROM node\nARG UPLOAD_DIR\nENV UPLOAD_DIR=/data NODE_ENV=production\nENV OTHER=${UPLOAD_DIR}\n'
    expect(lines(definitionsIn('Dockerfile', text, 'UPLOAD_DIR'))).toEqual([2, 3])
  })

  it('reads systemd Environment lines', () => {
    const text = '[Service]\nEnvironment=PORT=8080 UPLOAD_DIR=/srv/up\n'
    expect(lines(definitionsIn('app.service', text, 'UPLOAD_DIR'))).toEqual([2])
  })

  it('finds nothing for a bad name', () => {
    expect(definitionsIn('.env', 'X=1', '../x')).toEqual([])
  })
})

describe('placeholderAt', () => {
  it('finds the placeholder under a column, with its default', () => {
    const line = '    dir: ${UPLOAD_DIR:./uploads}'
    expect(placeholderAt(line, 12)).toEqual({ name: 'UPLOAD_DIR', fallback: './uploads' })
    expect(placeholderAt(line, 2)).toBeNull()
    expect(placeholderAt('url: ${DB_URL}', 8)).toEqual({ name: 'DB_URL', fallback: null })
  })
})

describe('searchLocal', () => {
  it('walks the folder, skipping generated folders, nearest first', async () => {
    const fs = await import('fs')
    const os = await import('os')
    const path = await import('path')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgrefs-'))
    try {
      fs.writeFileSync(path.join(root, '.env'), 'UPLOAD_DIR=/data\n')
      fs.mkdirSync(path.join(root, 'deploy'))
      fs.writeFileSync(path.join(root, 'deploy', 'docker-compose.yml'), 'services:\n  app:\n    environment:\n      UPLOAD_DIR: /srv\n')
      fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true })
      fs.writeFileSync(path.join(root, 'node_modules', 'x', '.env'), 'UPLOAD_DIR=/nope\n')
      const { searchLocal } = await import('./configRefs.js')
      const found = await searchLocal(root, 'UPLOAD_DIR')
      expect(found.results.map(r => [r.shown.split(path.sep).join('/'), r.line])).toEqual([['.env', 1], ['deploy/docker-compose.yml', 4]])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('searchRemote', () => {
  it('reads candidate files of the folder and the folders above, over SFTP only', async () => {
    const { searchRemote } = await import('./configRefs.js')
    const tree = {
      '/srv/app/config': [{ filename: 'application.yml', attrs: { isFile: () => true } }, { filename: 'notes.md', attrs: { isFile: () => true } }],
      '/srv/app': [{ filename: '.env', attrs: { isFile: () => true } }, { filename: 'config', attrs: { isFile: () => false } }],
      '/srv': [], '/': []
    }
    const texts = { '/srv/app/config/application.yml': 'app:\n  dir: ${UPLOAD_DIR}\n', '/srv/app/.env': 'UPLOAD_DIR=/data\n' }
    const read = []
    const found = await searchRemote('/srv/app/config/application.yml', 'UPLOAD_DIR', {
      readdir: async (dir) => tree[dir] ?? [],
      readText: async (file) => { read.push(file); return texts[file] }
    })
    expect(found.results).toEqual([{ path: '/srv/app/.env', shown: '/srv/app/.env', line: 1, text: 'UPLOAD_DIR=/data' }])
    expect(read).not.toContain('/srv/app/config/notes.md')
  })
})
