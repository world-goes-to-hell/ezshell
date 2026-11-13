import { describe, it, expect } from 'vitest'
import { fileZone, visiblePart, allowsName, isRelativeName } from './terminalFileZone'

describe('fileZone', () => {
  it('runs from the line where the folder last changed to the line above the cursor', () => {
    expect(fileZone({ start: 40, cursorRow: 46, isAlternate: false })).toEqual({ start: 40, end: 45 })
  })

  it('is empty right after the folder changed (nothing printed yet)', () => {
    expect(fileZone({ start: 46, cursorRow: 46, isAlternate: false })).toBeNull()
  })

  it('does not exist without a known folder or in a full-screen program', () => {
    expect(fileZone({ start: null, cursorRow: 46, isAlternate: false })).toBeNull()
    expect(fileZone({ start: 40, cursorRow: 46, isAlternate: true })).toBeNull()
  })
})

describe('visiblePart', () => {
  const zone = { start: 40, end: 45 }

  it('is the whole zone when it is on screen', () => {
    expect(visiblePart(zone, 30, 24)).toEqual({ top: 40, height: 6, cutTop: false, cutBottom: false })
  })

  it('starts at the top row when the zone began above the screen', () => {
    expect(visiblePart(zone, 43, 24)).toEqual({ top: 43, height: 3, cutTop: true, cutBottom: false })
  })

  it('ends at the bottom row when the zone goes below the screen (scrolled up)', () => {
    expect(visiblePart(zone, 30, 12)).toEqual({ top: 40, height: 2, cutTop: false, cutBottom: true })
  })

  it('is nothing when the zone is entirely off screen', () => {
    expect(visiblePart(zone, 0, 24)).toBeNull()
    expect(visiblePart(zone, 50, 24)).toBeNull()
  })
})

describe('allowsName', () => {
  const zone = { start: 40, end: 45 }

  it('tells relative names from absolute and home paths', () => {
    expect(isRelativeName('catalina.log')).toBe(true)
    expect(isRelativeName('logs/app.log')).toBe(true)
    expect(isRelativeName('/data/app.log')).toBe(false)
    expect(isRelativeName('~/app.log')).toBe(false)
  })

  it('takes relative names only inside the zone', () => {
    expect(allowsName('catalina.log', 42, zone)).toBe(true)
    expect(allowsName('was.env', 30, zone)).toBe(false)
    expect(allowsName('was.env', 46, zone)).toBe(false)
    expect(allowsName('was.env', 30, null)).toBe(false)
  })

  it('takes absolute and home paths anywhere', () => {
    expect(allowsName('/data/wscope-dev/was.env', 30, zone)).toBe(true)
    expect(allowsName('~/app.log', 30, null)).toBe(true)
  })
})
