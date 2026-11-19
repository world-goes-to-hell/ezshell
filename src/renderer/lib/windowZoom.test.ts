import { describe, it, expect } from 'vitest'
import { parseWindowZoom, isZoomWindowKind, windowZoomKey } from './windowZoom'

describe('parseWindowZoom', () => {
  it('reads a stored factor, snapped to the nearest preset', () => {
    expect(parseWindowZoom('1.25')).toBe(1.25)
    expect(parseWindowZoom('1.2400001')).toBe(1.25)
    expect(parseWindowZoom('0.8')).toBe(0.8)
  })

  it('is 100% without a value or with one it cannot use, and stays within the presets', () => {
    expect(parseWindowZoom(null)).toBe(1)
    expect(parseWindowZoom('')).toBe(1)
    expect(parseWindowZoom('abc')).toBe(1)
    expect(parseWindowZoom('9')).toBe(2)
    expect(parseWindowZoom('0.1')).toBe(0.5)
  })
})

describe('kinds', () => {
  it('knows the detached window kinds and keys them apart', () => {
    expect(isZoomWindowKind('remoteFile')).toBe(true)
    expect(isZoomWindowKind('main')).toBe(false)
    expect(windowZoomKey('sftp')).not.toBe(windowZoomKey('db'))
  })
})
