import { describe, it, expect } from 'vitest'
import { macMenuTemplate, FORBIDDEN_ROLES } from './macMenu.js'

const rolesOf = (template) => template.flatMap(menu => menu.submenu.map(item => item.role).filter(Boolean))

describe('macOS application menu', () => {
  const template = macMenuTemplate('ezShell')

  it('keeps quit, hide, the edit commands and minimize', () => {
    const roles = rolesOf(template)
    for (const role of ['quit', 'hide', 'undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'minimize']) {
      expect(roles).toContain(role)
    }
  })

  it('has nothing that reloads, closes or zooms the window from a shortcut', () => {
    const roles = rolesOf(template).map(role => role.toLowerCase())
    for (const role of FORBIDDEN_ROLES) expect(roles).not.toContain(role.toLowerCase())
  })

  it('names the first menu after the app (macOS shows it as the app menu)', () => {
    expect(template[0].label).toBe('ezShell')
    expect(template[0].submenu.find(item => item.role === 'quit').label).toBe('ezShell 종료')
  })

  it('gives every item a label or a separator', () => {
    for (const menu of template) {
      for (const item of menu.submenu) expect(item.type === 'separator' || typeof item.label === 'string').toBe(true)
    }
  })
})
