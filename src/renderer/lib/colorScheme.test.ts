import { describe, it, expect } from 'vitest'
import { colorSchemeFor } from './colorScheme'

describe('colorSchemeFor', () => {
  it('is dark for dark backgrounds', () => {
    expect(colorSchemeFor('#1c1d21')).toBe('dark') // minimal-dark
    expect(colorSchemeFor('#002b36')).toBe('dark') // solarized-dark
    expect(colorSchemeFor('#000000')).toBe('dark')
  })

  it('is light for light backgrounds', () => {
    expect(colorSchemeFor('#ffffff')).toBe('light')
    expect(colorSchemeFor('#fdf6e3')).toBe('light') // solarized-light
    expect(colorSchemeFor('#f4f5f7')).toBe('light')
  })

  it('accepts short hex and leaves anything unreadable undecided', () => {
    expect(colorSchemeFor('#fff')).toBe('light')
    expect(colorSchemeFor('rgb(0, 0, 0)')).toBeNull()
    expect(colorSchemeFor('')).toBeNull()
  })
})
