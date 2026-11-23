import { describe, expect, it, vi } from 'vitest'
import { browserContextMenu } from './browserContextMenu.js'

function pageOf(extra = {}) {
  return {
    canGoBack: true, canGoForward: false, isWebUrl: url => /^https?:\/\//.test(url),
    openTab: vi.fn(), openExternal: vi.fn(), copy: vi.fn(), back: vi.fn(), forward: vi.fn(), reload: vi.fn(),
    copyImage: vi.fn(), edit: vi.fn(), inspect: vi.fn(), ...extra
  }
}
const labels = template => template.map(item => item.type === 'separator' ? '-' : item.label)
const item = (template, label) => template.find(entry => entry.label === label)

describe('the browser tab’s right-click menu', () => {
  it('offers to open a link in a new tab or the default browser, and to copy its address', () => {
    const page = pageOf()
    const menu = browserContextMenu({ linkURL: 'https://arcane.yooit.kr/', linkText: 'arcane.yooit.kr', x: 10, y: 20, editFlags: {} }, page)
    expect(labels(menu)).toEqual(['새 탭에서 링크 열기', '기본 브라우저에서 링크 열기', '링크 주소 복사', '링크 텍스트 복사', '-', '검사'])
    item(menu, '새 탭에서 링크 열기').click()
    item(menu, '링크 주소 복사').click()
    item(menu, '검사').click()
    expect(page.openTab).toHaveBeenCalledWith('https://arcane.yooit.kr/')
    expect(page.copy).toHaveBeenCalledWith('https://arcane.yooit.kr/')
    expect(page.inspect).toHaveBeenCalledWith(10, 20)
  })

  it('copies but does not open a link that is not a web address', () => {
    const menu = browserContextMenu({ linkURL: 'mailto:a@b.c', editFlags: {} }, pageOf())
    expect(item(menu, '새 탭에서 링크 열기').enabled).toBe(false)
    expect(item(menu, '기본 브라우저에서 링크 열기').enabled).toBe(false)
    expect(item(menu, '링크 주소 복사').enabled).toBeUndefined()
  })

  it('has the page’s own actions on an empty spot: back as far as it goes, reload, its address', () => {
    const page = pageOf()
    const menu = browserContextMenu({ pageURL: 'https://npm.yooit.kr/nginx/proxy', editFlags: {} }, page)
    expect(labels(menu)).toEqual(['뒤로', '앞으로', '새로고침', '-', '페이지 주소 복사', '-', '검사'])
    expect(item(menu, '앞으로').enabled).toBe(false)
    item(menu, '페이지 주소 복사').click()
    expect(page.copy).toHaveBeenCalledWith('https://npm.yooit.kr/nginx/proxy')
  })

  it('edits a field with what it allows, and copies a selection', () => {
    const page = pageOf()
    const field = browserContextMenu({ isEditable: true, editFlags: { canPaste: true, canSelectAll: true } }, page)
    expect(item(field, '붙여넣기').enabled).toBe(true)
    expect(item(field, '잘라내기').enabled).toBe(false)
    item(field, '붙여넣기').click()
    expect(page.edit).toHaveBeenCalledWith('paste')
    expect(labels(browserContextMenu({ selectionText: '172.30.1.72', editFlags: {} }, page))).toEqual(['복사', '-', '검사'])
  })

  it('opens or copies an image', () => {
    const page = pageOf()
    const menu = browserContextMenu({ mediaType: 'image', srcURL: 'https://x.kr/a.png', x: 3, y: 4, editFlags: {} }, page)
    expect(labels(menu)).toEqual(['새 탭에서 이미지 열기', '이미지 복사', '이미지 주소 복사', '-', '검사'])
    item(menu, '이미지 복사').click()
    expect(page.copyImage).toHaveBeenCalledWith(3, 4)
  })
})
