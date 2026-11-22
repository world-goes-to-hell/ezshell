import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { customCommands } from './slashCommands.js'

let root

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-commands-')) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe('the slash commands the user made', () => {
  it('lists Claude\'s commands and skills, the project\'s over the user\'s, without hidden skills', async () => {
    const home = path.join(root, 'home')
    const project = path.join(root, 'project')
    write(path.join(home, '.claude', 'commands', 'q-copy.md'), '---\ndescription: "질문 복사"\n---\nbody')
    write(path.join(home, '.claude', 'commands', 'git', 'ship.md'), 'no front matter')
    write(path.join(home, '.claude', 'commands', 'plan.md'), '---\ndescription: |\n  계획을\n  세운다\nmodel: x\n---')
    write(path.join(home, '.claude', 'skills', 'browse', 'SKILL.md'), '---\nname: browse\ndescription: 브라우저\n  여러 줄\n---')
    write(path.join(home, '.claude', 'skills', 'inner', 'SKILL.md'), '---\nname: inner\nuser-invocable: false\n---')
    write(path.join(project, '.claude', 'commands', 'q-copy.md'), '---\ndescription: 프로젝트 것\n---')
    write(path.join(home, '.claude', 'commands', 'bad name.md'), '---\ndescription: x\n---')
    const list = await customCommands({ kind: 'claude', cwd: project, env: {}, home })
    expect(list).toEqual([
      { name: '/browse', description: '브라우저', source: 'user' },
      { name: '/plan', description: '계획을 세운다', source: 'user' },
      { name: '/q-copy', description: '프로젝트 것', source: 'project' },
      { name: '/ship', description: '', source: 'user' }
    ])
  })

  it('lists Codex\'s prompts as /prompts:<name>, from CODEX_HOME', async () => {
    const codexHome = path.join(root, 'codex')
    write(path.join(codexHome, 'prompts', 'review.md'), '---\ndescription: 리뷰\n---')
    expect(await customCommands({ kind: 'codex', cwd: null, env: { CODEX_HOME: codexHome }, home: root }))
      .toEqual([{ name: '/prompts:review', description: '리뷰', source: 'user' }])
  })

  it('reads no project folder that is not on this PC', async () => {
    expect(await customCommands({ kind: 'claude', cwd: '\\\\host\\share', env: {}, home: path.join(root, 'none') })).toEqual([])
  })
})
