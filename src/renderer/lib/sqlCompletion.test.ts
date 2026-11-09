import { describe, it, expect } from 'vitest'
import { completionSpot, referencedTables, resolveQualifier, identifierText, unquote } from './sqlCompletion'
import { createSerialQueue } from './serialQueue'

describe('completionSpot', () => {
  it('finds a qualified name being typed', () => {
    expect(completionSpot('SELECT o.')).toEqual({ kind: 'qualified', qualifier: 'o', prefix: '' })
    expect(completionSpot('SELECT orders.cu')).toEqual({ kind: 'qualified', qualifier: 'orders', prefix: 'cu' })
    expect(completionSpot('SELECT * FROM `my db`.ord')).toEqual({ kind: 'qualified', qualifier: 'my db', prefix: 'ord' })
    expect(completionSpot('SELECT "Order".Id')).toEqual({ kind: 'qualified', qualifier: 'Order', prefix: 'Id' })
  })

  it('finds a plain word being typed', () => {
    expect(completionSpot('SELECT * FROM ord')).toEqual({ kind: 'plain', prefix: 'ord' })
    expect(completionSpot('SELECT ')).toEqual({ kind: 'plain', prefix: '' })
  })
})

describe('referencedTables', () => {
  it('reads tables with schemas and aliases after FROM and JOIN', () => {
    const sql = 'SELECT * FROM shop.orders o JOIN customers AS c ON c.id = o.customer_id LEFT JOIN `order items` WHERE 1'
    expect(referencedTables(sql)).toEqual([
      { schema: 'shop', table: 'orders', alias: 'o' },
      { schema: null, table: 'customers', alias: 'c' },
      { schema: null, table: 'order items', alias: null }
    ])
  })

  it('does not take keywords for aliases', () => {
    expect(referencedTables('SELECT * FROM orders WHERE id = 1')).toEqual([{ schema: null, table: 'orders', alias: null }])
    expect(referencedTables('SELECT * FROM orders JOIN items ON true')[0].alias).toBeNull()
  })
})

describe('resolveQualifier', () => {
  const tables = [{ schema: 'shop', table: 'orders', alias: 'o' }, { schema: null, table: 'customers', alias: null }]
  it('finds by alias, then by table name', () => {
    expect(resolveQualifier('O', tables)?.table).toBe('orders')
    expect(resolveQualifier('customers', tables)?.table).toBe('customers')
    expect(resolveQualifier('items', tables)).toBeNull()
  })
})

describe('identifierText', () => {
  it('quotes only when needed', () => {
    expect(identifierText('orders', 'mysql')).toBe('orders')
    expect(identifierText('order items', 'mysql')).toBe('`order items`')
    expect(identifierText('orders', 'postgres')).toBe('orders')
    expect(identifierText('Orders', 'postgres')).toBe('"Orders"')
    expect(unquote('"a""b"')).toBe('a"b')
  })
})

describe('createSerialQueue', () => {
  it('runs one request at a time, in order, and goes on after a failure', async () => {
    const queue = createSerialQueue()
    const log: string[] = []
    let releaseFirst: () => void = () => {}
    const first = queue.run(() => new Promise<string>((resolve) => { releaseFirst = () => { log.push('first'); resolve('a') } }))
    const second = queue.run(async () => { log.push('second'); throw new Error('x') })
    const third = queue.run(async () => { log.push('third'); return 'c' })
    await Promise.resolve()
    expect(log).toEqual([])
    releaseFirst()
    await expect(first).resolves.toBe('a')
    await expect(second).rejects.toThrow('x')
    await expect(third).resolves.toBe('c')
    expect(log).toEqual(['first', 'second', 'third'])
  })
})
