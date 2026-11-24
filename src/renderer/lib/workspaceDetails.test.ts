import { describe, expect, it } from 'vitest'
import { diffLineKind, isMediaFile, joinRelative, relativeInside, revealStep, splitPath } from './workspaceDetails'

describe('workspace details', () => {
  it('opens images and PDFs in the preview, the rest in the editor', () => {
    expect(isMediaFile('docs/logo.PNG')).toBe(true)
    expect(isMediaFile('a\\report.pdf')).toBe(true)
    expect(isMediaFile('src/app.ts')).toBe(false)
    expect(isMediaFile('.png')).toBe(false)
  })

  it('finds a folder of a chat link below the panel root, keeping the folder names as written', () => {
    expect(relativeInside('d:\\dev\\app', 'D:\\DEV\\app\\mockups\\v2')).toBe('mockups/v2')
    expect(relativeInside('D:\\DEV\\app\\', 'D:\\DEV\\app')).toBe('')
    expect(relativeInside('/home/me/app', '/home/me/app/docs')).toBe('docs')
    expect(relativeInside('/home/me/app', '/home/me/App/docs')).toBeNull()
    expect(relativeInside('D:\\DEV\\app', 'D:\\DEV\\apple\\x')).toBeNull()
    expect(relativeInside('D:\\DEV\\app', 'D:\\other')).toBeNull()
  })

  it('opens the tree folders on the way to a revealed folder', () => {
    expect(revealStep('docs', 'docs/plan', false)).toBe('ancestor')
    expect(revealStep('docs/plan', 'docs/plan', false)).toBe('target')
    expect(revealStep('Docs', 'docs/plan', true)).toBe('ancestor')
    expect(revealStep('Docs', 'docs/plan', false)).toBeNull()
    expect(revealStep('doc', 'docs/plan', false)).toBeNull()
  })

  it('joins relative paths with forward slashes', () => {
    expect(joinRelative('', 'src')).toBe('src')
    expect(joinRelative('src', 'a.ts')).toBe('src/a.ts')
  })

  it('tells the kinds of diff lines apart', () => {
    expect(['@@ -1 +1 @@', '+new', '-old', ' same', '\\ No newline at end of file'].map(diffLineKind)).toEqual(['hunk', 'add', 'remove', 'context', 'note'])
  })

  it('splits a path into name and folder', () => {
    expect(splitPath('src/lib/a.ts')).toEqual({ name: 'a.ts', folder: 'src/lib' })
    expect(splitPath('README.md')).toEqual({ name: 'README.md', folder: '' })
  })
})
