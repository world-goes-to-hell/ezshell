import { describe, expect, it } from 'vitest'
import { diffLineKind, isMediaFile, joinRelative, splitPath } from './workspaceDetails'

describe('workspace details', () => {
  it('opens images and PDFs in the preview, the rest in the editor', () => {
    expect(isMediaFile('docs/logo.PNG')).toBe(true)
    expect(isMediaFile('a\\report.pdf')).toBe(true)
    expect(isMediaFile('src/app.ts')).toBe(false)
    expect(isMediaFile('.png')).toBe(false)
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
