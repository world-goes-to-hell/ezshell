import { describe, it, expect } from 'vitest'
import {
  duplicateIds, initialSelection, sessionsUnder, folderCheckState, stageNode, stageAll, removeStaged, mergeOrder, addStagedFolder, EMPTY_STAGE,
  type ImportResult
} from './externalImport'

const result: ImportResult = {
  source: 'xshell',
  label: 'Xshell 8',
  folders: [
    { id: 'f1', name: '개발', parentId: null },
    { id: 'f2', name: 'MBRIS', parentId: 'f1' },
    { id: 'f3', name: '빈 폴더', parentId: null }
  ],
  sessions: [
    { id: 's1', name: 'web', folderId: 'f2', host: '10.0.0.5', port: 22, username: 'root', authType: 'password', privateKeyPath: '', keyNote: '', hasSavedPassword: true, jump: null },
    { id: 's2', name: 'db', folderId: 'f2', host: 'DB.example.com', port: 22, username: 'dba', authType: 'privateKey', privateKeyPath: 'C:\\k', keyNote: '', hasSavedPassword: false, jump: { host: 'bastion', port: 22, username: 'j' } },
    { id: 's3', name: 'top', folderId: null, host: 'top', port: 2222, username: '', authType: 'password', privateKeyPath: '', keyNote: '', hasSavedPassword: null, jump: null }
  ],
  skipped: {},
  truncated: false
}

const existing = [{ id: 'e1', name: 'old db', host: 'db.example.com', port: 22, username: 'dba', authType: 'password' as const }]
let n = 0
const newId = () => `n${++n}`

describe('externalImport', () => {
  it('finds sessions that already exist (host ignoring case, port, user) and leaves them unchecked', () => {
    expect([...duplicateIds(result, existing)]).toEqual(['s2'])
    expect([...initialSelection(result, existing)].sort()).toEqual(['s1', 's3'])
  })

  it('collects sessions under a folder and tells its check state', () => {
    expect(sessionsUnder(result, 'f1').sort()).toEqual(['s1', 's2'])
    expect(folderCheckState(result, 'f1', new Set(['s1']))).toBe('some')
    expect(folderCheckState(result, 'f1', new Set(['s1', 's2']))).toBe('all')
    expect(folderCheckState(result, 'f3', new Set())).toBe('empty')
  })

  it('drops a folder into a folder of mine: its tree with the checked sessions only', () => {
    n = 0
    const stage = stageNode(EMPTY_STAGE, { result, node: { type: 'folder', id: 'f1' }, targetFolderId: 'mine', selected: new Set(['s1']), newId })
    expect(stage.folders.map(f => [f.name, f.parentId])).toEqual([['개발', 'mine'], ['MBRIS', 'n1']])
    expect(stage.sessions).toHaveLength(1)
    expect(stage.sessions[0]).toMatchObject({
      name: 'web', host: '10.0.0.5', port: 22, username: 'root', folderId: 'n2', mcpEnabled: false, authType: 'password', importedId: 's1'
    })
    expect(stage.sessions[0].password).toBeUndefined()
  })

  it('drops one session even if unchecked, with its key and jump host, and never twice', () => {
    n = 0
    let stage = stageNode(EMPTY_STAGE, { result, node: { type: 'session', id: 's2' }, targetFolderId: null, selected: new Set(), newId })
    stage = stageNode(stage, { result, node: { type: 'session', id: 's2' }, targetFolderId: null, selected: new Set(), newId })
    expect(stage.sessions).toHaveLength(1)
    expect(stage.sessions[0]).toMatchObject({
      folderId: undefined, authType: 'privateKey', privateKeyPath: 'C:\\k',
      useJumpHost: true, jumpHost: 'bastion', jumpPort: 22, jumpUsername: 'j', jumpAuthType: 'password'
    })
  })

  it('leaves out folders with nothing checked in them', () => {
    const stage = stageNode(EMPTY_STAGE, { result, node: { type: 'folder', id: 'f3' }, targetFolderId: null, selected: new Set(['s1']), newId })
    expect(stage).toEqual(EMPTY_STAGE)
  })

  it('applies everything checked under one new folder named after the program', () => {
    n = 0
    const stage = stageAll({ result, selected: new Set(['s1', 's3']), newId })
    expect(stage.folders.map(f => [f.name, f.parentId])).toEqual([['가져옴 - Xshell 8', undefined], ['개발', 'n1'], ['MBRIS', 'n2']])
    expect(stage.sessions.map(s => [s.name, s.folderId])).toEqual([['web', 'n3'], ['top', 'n1']])
  })

  it('removes a staged folder with everything staged inside it', () => {
    n = 0
    const stage = stageNode(EMPTY_STAGE, { result, node: { type: 'folder', id: 'f1' }, targetFolderId: null, selected: new Set(['s1', 's2']), newId })
    const after = removeStaged(stage, { type: 'folder', id: stage.folders[0].id })
    expect(after).toEqual(EMPTY_STAGE)
    const one = removeStaged(stage, { type: 'session', id: stage.sessions[0].id })
    expect(one.sessions).toHaveLength(1)
  })
})

describe('placing staged sessions among mine', () => {
  const mine = [
    { id: 'a', name: 'a', host: 'a', port: 22, username: '', authType: 'password' as const, folderId: 'F' },
    { id: 'b', name: 'b', host: 'b', port: 22, username: '', authType: 'password' as const, folderId: 'F' },
    { id: 'c', name: 'c', host: 'c', port: 22, username: '', authType: 'password' as const }
  ]

  it('puts a dropped session before or after the session it was dropped on, in that folder', () => {
    n = 0
    let stage = stageNode(EMPTY_STAGE, { result, node: { type: 'session', id: 's1' }, targetFolderId: 'F', anchor: { id: 'b', position: 'before' }, selected: new Set(), newId })
    stage = stageNode(stage, { result, node: { type: 'session', id: 's3' }, targetFolderId: 'F', anchor: { id: 'a', position: 'after' }, selected: new Set(), newId })
    expect(mergeOrder(mine, stage.sessions).map(s => s.id)).toEqual(['a', 'n2', 'n1', 'b', 'c'])
    expect(stage.sessions.every(s => s.folderId === 'F')).toBe(true)
  })

  it('keeps the drop order for several sessions after the same session', () => {
    n = 0
    let stage = stageNode(EMPTY_STAGE, { result, node: { type: 'session', id: 's1' }, targetFolderId: 'F', anchor: { id: 'a', position: 'after' }, selected: new Set(), newId })
    stage = stageNode(stage, { result, node: { type: 'session', id: 's3' }, targetFolderId: 'F', anchor: { id: 'a', position: 'after' }, selected: new Set(), newId })
    expect(mergeOrder(mine, stage.sessions).map(s => s.id)).toEqual(['a', 'n1', 'n2', 'b', 'c'])
  })

  it('can place next to a staged session, and appends what has no place', () => {
    n = 0
    let stage = stageNode(EMPTY_STAGE, { result, node: { type: 'session', id: 's1' }, targetFolderId: null, selected: new Set(), newId })
    stage = stageNode(stage, { result, node: { type: 'session', id: 's3' }, targetFolderId: null, anchor: { id: 'n1', position: 'before' }, selected: new Set(), newId })
    expect(mergeOrder(mine, stage.sessions).map(s => s.id)).toEqual(['a', 'b', 'c', 'n2', 'n1'])
  })

  it('moves sessions placed next to a removed staged session to where that one was', () => {
    n = 0
    let stage = stageNode(EMPTY_STAGE, { result, node: { type: 'session', id: 's1' }, targetFolderId: 'F', anchor: { id: 'a', position: 'after' }, selected: new Set(), newId })
    stage = stageNode(stage, { result, node: { type: 'session', id: 's3' }, targetFolderId: 'F', anchor: { id: 'n1', position: 'after' }, selected: new Set(), newId })
    const after = removeStaged(stage, { type: 'session', id: 'n1' })
    expect(mergeOrder(mine, after.sessions).map(s => s.id)).toEqual(['a', 'n2', 'b', 'c'])
  })
})

describe('folders made in the panel', () => {
  it('adds a named folder under the chosen one, ignoring blank names', () => {
    n = 0
    let stage = addStagedFolder(EMPTY_STAGE, { name: '  새 프로젝트 ', parentId: 'mine', newId })
    stage = addStagedFolder(stage, { name: '   ', parentId: null, newId })
    expect(stage.folders).toEqual([{ id: 'n1', name: '새 프로젝트', parentId: 'mine' }])
    const top = addStagedFolder(EMPTY_STAGE, { name: 'top', parentId: null, newId })
    expect(top.folders[0].parentId).toBeUndefined()
  })
})
