import { describe, it, expect, vi } from 'vitest'
import { createDbConnections, validateRequest } from './connections.js'
import { registerDbIpc } from './ipc.js'

const REQUEST = {
  sessionId: 'tab-1',
  sessionName: 'prod',
  endpoint: { engine: 'mysql', host: '127.0.0.1', port: 3306 },
  credentials: { user: 'reader', password: 'secret', database: 'shop' }
}

function fakeSession({ queryResult = { columns: [], rows: [], truncatedBy: null, affectedRows: null, elapsedMs: 1 } } = {}) {
  let release = null
  return {
    open: vi.fn().mockResolvedValue({ engine: 'mysql', product: 'MySQL', version: '8.0.36', missingGuards: [] }),
    query: vi.fn().mockImplementation(() => new Promise((resolve) => { release = () => resolve(queryResult) })),
    cancel: vi.fn().mockResolvedValue(true),
    listDatabases: vi.fn().mockResolvedValue([{ name: 'shop', isSystem: false }, { name: 'mysql', isSystem: true }]),
    listSchemas: vi.fn().mockImplementation(async (db) => [{ name: db, isSystem: false }]),
    listTables: vi.fn().mockResolvedValue([{ name: 'orders', kind: 'table' }]),
    listColumns: vi.fn().mockResolvedValue([]),
    useDatabase: vi.fn().mockImplementation(async function (name) { this.database = name }),
    close: vi.fn(),
    info: { engine: 'mysql', product: 'MySQL', version: '8.0.36', missingGuards: [] },
    database: 'shop',
    defaultSchema: 'shop',
    finishQuery: () => release()
  }
}

function setup() {
  const session = fakeSession()
  const openStream = vi.fn()
  const createSession = vi.fn().mockReturnValue(session)
  const connections = createDbConnections({ openStream, createSession })
  return { session, openStream, createSession, connections }
}

describe('validateRequest', () => {
  it('keeps clean copies of what the window sent', () => {
    expect(validateRequest({ ...REQUEST, endpoint: { ...REQUEST.endpoint, host: ' 10.0.0.5 ', port: '5432', extra: 1 } })).toEqual({
      endpoint: { engine: 'mysql', host: '10.0.0.5', port: 5432 },
      credentials: { user: 'reader', password: 'secret', database: 'shop' }
    })
  })

  it('refuses bad ports, hosts, users and engines', () => {
    const bad = [
      { endpoint: { ...REQUEST.endpoint, port: 0 } },
      { endpoint: { ...REQUEST.endpoint, port: 70000 } },
      { endpoint: { ...REQUEST.endpoint, host: 'a b' } },
      { endpoint: { ...REQUEST.endpoint, host: 'user@host' } },
      { credentials: { ...REQUEST.credentials, user: ' ' } },
      { endpoint: { ...REQUEST.endpoint, engine: 'oracle' } }
    ]
    for (const change of bad) expect(() => validateRequest({ ...REQUEST, ...change })).toThrow()
  })
})

describe('createDbConnections', () => {
  it('connects through a tunnel of the tab and answers only the attached window', async () => {
    const { connections, createSession, openStream } = setup()
    const { dbId, info } = await connections.open(REQUEST)
    expect(info.product).toBe('MySQL')
    createSession.mock.calls[0][1].openStream()
    expect(openStream).toHaveBeenCalledWith('tab-1', '127.0.0.1', 3306)

    connections.attach(dbId, 7)
    expect(connections.describe(7, dbId)).toMatchObject({ database: 'shop', user: 'reader', sessionName: 'prod' })
    expect(() => connections.describe(8, dbId)).toThrow('접속 정보가 없습니다')
    expect(JSON.stringify(connections.describe(7, dbId))).not.toContain('secret')
  })

  it('checks the query before sending it', async () => {
    const { connections, session } = setup()
    const { dbId } = await connections.open(REQUEST)
    connections.attach(dbId, 7)
    expect(() => connections.query(7, dbId, 'DELETE FROM orders')).toThrow('조회 문장만')
    expect(session.query).not.toHaveBeenCalled()
  })

  it('runs one request at a time and can cancel the running one', async () => {
    const { connections, session } = setup()
    const { dbId } = await connections.open(REQUEST)
    connections.attach(dbId, 7)
    expect(await connections.cancel(7, dbId)).toEqual({ cancelled: false })

    const running = connections.query(7, dbId, 'SELECT * FROM orders')
    await expect(connections.databases(7, dbId)).rejects.toThrow('처리하는 중')
    expect(await connections.cancel(7, dbId)).toEqual({ cancelled: true })
    session.finishQuery()
    await expect(running).resolves.toMatchObject({ database: 'shop' })
    await expect(connections.schemas(7, dbId, 'shop')).resolves.toEqual({ schemas: [{ name: 'shop', isSystem: false }], defaultSchema: 'shop' })
  })

  it('lists every database and accepts only names from that list', async () => {
    const { connections, session } = setup()
    const { dbId } = await connections.open(REQUEST)
    connections.attach(dbId, 7)
    expect(await connections.databases(7, dbId)).toEqual({ databases: [{ name: 'shop', isSystem: false }, { name: 'mysql', isSystem: true }], current: 'shop' })
    // Another database's schemas: no default schema there (queries do not run in it)
    expect(await connections.schemas(7, dbId, 'mysql')).toEqual({ schemas: [{ name: 'mysql', isSystem: false }], defaultSchema: null })
    await expect(connections.tables(7, dbId, 'secret_db', 'x')).rejects.toThrow('DB 목록에 없습니다')
    expect(session.listTables).not.toHaveBeenCalled()
    await connections.tables(7, dbId, 'mysql', 'mysql')
    expect(session.listTables).toHaveBeenCalledWith('mysql', 'mysql')
  })

  it('switches the database queries run in', async () => {
    const { connections, session } = setup()
    const { dbId } = await connections.open(REQUEST)
    connections.attach(dbId, 7)
    await expect(connections.switchDatabase(7, dbId, 'nope')).rejects.toThrow('DB 목록에 없습니다')
    expect(await connections.switchDatabase(7, dbId, 'mysql')).toMatchObject({ database: 'mysql' })
    expect(session.useDatabase).toHaveBeenCalledWith('mysql')
  })

  it('tests an account by logging in once and closing again', async () => {
    const { connections, session } = setup()
    expect(await connections.test(REQUEST)).toEqual({ info: session.info, database: 'shop' })
    expect(session.close).toHaveBeenCalledTimes(1)
    session.open.mockRejectedValueOnce(new Error('denied'))
    await expect(connections.test(REQUEST)).rejects.toThrow('denied')
    expect(session.close).toHaveBeenCalledTimes(2)
  })

  it('closes the session with its window', async () => {
    const { connections, session } = setup()
    const { dbId } = await connections.open(REQUEST)
    connections.close(dbId)
    expect(session.close).toHaveBeenCalled()
    expect(connections.has(dbId)).toBe(false)
  })
})

function fakeIpc() {
  const handlers = new Map()
  return {
    handle: (name, fn) => handlers.set(name, fn),
    call: (name, senderId, request) => handlers.get(name)({ sender: { id: senderId } }, request)
  }
}

function fakeWindow(id) {
  const listeners = {}
  return {
    webContents: { id },
    isDestroyed: () => false,
    on: (name, fn) => { listeners[name] = fn },
    close: vi.fn(() => listeners.closed?.())
  }
}

describe('registerDbIpc', () => {
  it('opens a window for a connection and closes all of them when the app locks', async () => {
    const ipcMain = fakeIpc()
    const { connections, session } = setup()
    let isLocked = false
    const win = fakeWindow(11)
    let windowDbId = null
    const createWindow = (dbId) => { windowDbId = dbId; return win }
    const { closeAll } = registerDbIpc({ ipcMain, connections, discover: async () => [], createWindow, isLocked: () => isLocked })

    const opened = await ipcMain.call('db-open', 1, REQUEST)
    expect(opened).toMatchObject({ success: true, info: { product: 'MySQL' } })
    expect(opened.dbId).toBeUndefined()
    expect(await ipcMain.call('db-databases', 11, { dbId: windowDbId })).toMatchObject({ success: true, current: 'shop' })
    // The main window (sender 1) opened it, but only the DB window is answered
    expect((await ipcMain.call('db-databases', 1, { dbId: windowDbId })).success).toBe(false)

    closeAll()
    expect(win.close).toHaveBeenCalled()
    expect(session.close).toHaveBeenCalled()

    isLocked = true
    expect(await ipcMain.call('db-discover', 1, { sessionId: 'tab-1' })).toEqual({ success: false, error: '앱이 잠겨 있습니다.' })
  })

  it('opens only for the main window', async () => {
    const ipcMain = fakeIpc()
    const { connections, createSession } = setup()
    const discover = vi.fn().mockResolvedValue([])
    registerDbIpc({ ipcMain, connections, discover, createWindow: () => fakeWindow(11), isMainWindow: (id) => id === 1 })
    expect(await ipcMain.call('db-open', 11, REQUEST)).toEqual({ success: false, error: '이 창에서는 DB 에 접속할 수 없습니다.' })
    expect((await ipcMain.call('db-discover', 11, { sessionId: 'tab-1' })).success).toBe(false)
    expect((await ipcMain.call('db-test', 11, REQUEST)).success).toBe(false)
    expect(createSession).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled()
  })

  it('closes the connection when the app locked during the login, or the window could not be made', async () => {
    const ipcMain = fakeIpc()
    const { connections, session } = setup()
    let isLocked = false
    session.open.mockImplementation(async () => { isLocked = true; return session.info })
    const createWindow = vi.fn(() => fakeWindow(11))
    registerDbIpc({ ipcMain, connections, discover: async () => [], createWindow, isLocked: () => isLocked })
    expect(await ipcMain.call('db-open', 1, REQUEST)).toEqual({ success: false, error: '앱이 잠겨 있습니다.' })
    expect(createWindow).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledTimes(1)

    const ipc2 = fakeIpc()
    const second = setup()
    registerDbIpc({ ipcMain: ipc2, connections: second.connections, discover: async () => [], createWindow: () => { throw new Error('no window') } })
    expect((await ipc2.call('db-open', 1, REQUEST)).success).toBe(false)
    expect(second.session.close).toHaveBeenCalledTimes(1)
  })

  it('counts logins still in progress towards the window limit', async () => {
    let finish = []
    const connections = createDbConnections({
      openStream: vi.fn(),
      createSession: () => ({ ...fakeSession(), open: () => new Promise((resolve) => finish.push(resolve)) })
    })
    const opens = Array.from({ length: 10 }, () => connections.open(REQUEST))
    await expect(connections.open(REQUEST)).rejects.toThrow('10개까지')
    finish.forEach((resolve) => resolve({ product: 'MySQL' }))
    await Promise.all(opens)
    finish = []
  })

  it('answers errors as Korean text', async () => {
    const ipcMain = fakeIpc()
    const connections = createDbConnections({
      openStream: vi.fn(),
      createSession: () => ({ ...fakeSession(), open: vi.fn().mockRejectedValue(Object.assign(new Error("Access denied for user 'reader'"), { code: 'ER_ACCESS_DENIED_ERROR' })) })
    })
    registerDbIpc({ ipcMain, connections, discover: async () => [], createWindow: () => fakeWindow(1) })
    const result = await ipcMain.call('db-open', 1, REQUEST)
    expect(result.success).toBe(false)
    expect(result.error).toContain('비밀번호가 맞지 않거나')
    expect(result.error).not.toContain('secret')
  })
})
