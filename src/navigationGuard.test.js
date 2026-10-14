import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import { pathToFileURL } from 'url'
import guardModule from './navigationGuard.js'

const { isAllowedNavigation, guardWebContents } = guardModule

const rendererFile = path.resolve('out', 'renderer', 'index.html')
const rendererUrl = pathToFileURL(rendererFile).href

describe('isAllowedNavigation', () => {
  it('allows the packaged renderer page, with any query or hash', () => {
    expect(isAllowedNavigation(rendererUrl, { rendererFile })).toBe(true)
    expect(isAllowedNavigation(`${rendererUrl}?mode=sftp&sessionId=a`, { rendererFile })).toBe(true)
    expect(isAllowedNavigation(`${rendererUrl}#top`, { rendererFile })).toBe(true)
  })

  it('refuses every other file, including a sibling of the renderer page', () => {
    expect(isAllowedNavigation(pathToFileURL(path.resolve('out', 'renderer', 'other.html')).href, { rendererFile })).toBe(false)
    expect(isAllowedNavigation('file:///C:/Windows/System32/drivers/etc/hosts', { rendererFile })).toBe(false)
    expect(isAllowedNavigation('file://attacker/share/index.html', { rendererFile })).toBe(false)
  })

  it('refuses web pages when no dev server is in use', () => {
    expect(isAllowedNavigation('https://example.com/', { rendererFile })).toBe(false)
    expect(isAllowedNavigation('http://localhost:15173/', { rendererFile })).toBe(false)
  })

  it('allows only the origin of the dev server in development', () => {
    const options = { rendererFile, devUrls: ['http://localhost:15173'] }
    expect(isAllowedNavigation('http://localhost:15173/?mode=terminal', options)).toBe(true)
    expect(isAllowedNavigation('http://localhost:15174/', options)).toBe(false)
    expect(isAllowedNavigation('http://localhost:15173.example.com/', options)).toBe(false)
    expect(isAllowedNavigation('https://localhost:15173/', options)).toBe(false)
  })

  it.each(['', 'not a url', 'javascript:alert(1)', 'data:text/html,<p>x</p>', 'about:blank', null, undefined])(
    'refuses %s',
    (url) => {
      expect(isAllowedNavigation(url, { rendererFile, devUrls: ['http://localhost:15173'] })).toBe(false)
    }
  )
})

describe('guardWebContents', () => {
  function fakeContents() {
    const handlers = {}
    return {
      handlers,
      on: (name, handler) => { handlers[name] = handler },
      setWindowOpenHandler: (handler) => { handlers.windowOpen = handler }
    }
  }

  it('stops navigation away from the app and lets the app page through', () => {
    const contents = fakeContents()
    guardWebContents(contents, { rendererFile })
    const blocked = { preventDefault: vi.fn() }
    contents.handlers['will-navigate'](blocked, 'https://example.com/')
    expect(blocked.preventDefault).toHaveBeenCalled()
    const allowed = { preventDefault: vi.fn() }
    contents.handlers['will-navigate'](allowed, `${rendererUrl}?mode=sftp`)
    expect(allowed.preventDefault).not.toHaveBeenCalled()
  })

  it('stops redirects the same way', () => {
    const contents = fakeContents()
    guardWebContents(contents, { rendererFile })
    const event = { preventDefault: vi.fn() }
    contents.handlers['will-redirect'](event, 'https://example.com/')
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('denies every new window and every webview', () => {
    const contents = fakeContents()
    guardWebContents(contents, { rendererFile })
    expect(contents.handlers.windowOpen({ url: rendererUrl })).toEqual({ action: 'deny' })
    const event = { preventDefault: vi.fn() }
    contents.handlers['will-attach-webview'](event)
    expect(event.preventDefault).toHaveBeenCalled()
  })
})
