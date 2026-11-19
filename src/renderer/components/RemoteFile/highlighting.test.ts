import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { highlightTree } from '@lezer/highlight'
import { highlightStyle, languageFor } from './codeEditorSetup'

/** The style class each piece of text gets ('' when none) */
async function classesOf(fileName: string, text: string): Promise<Map<string, string>> {
  const language = await languageFor(fileName)
  const state = EditorState.create({ doc: text, extensions: language ? [language] : [] })
  const tree = ensureSyntaxTree(state, text.length, 5000)
  const found = new Map<string, string>()
  if (tree) highlightTree(tree, highlightStyle, (from, to, classes) => found.set(text.slice(from, to).trim(), classes))
  return found
}

describe('configuration file highlighting', () => {
  it('tells keys, values and comments apart in .properties', async () => {
    const found = await classesOf('application.properties', '# comment\nserver.port=8080\n')
    const [comment, key, value] = [found.get('# comment'), found.get('server.port'), found.get('8080')]
    expect(comment && key && value).toBeTruthy()
    expect(new Set([comment, key, value]).size).toBe(3)
  })

  it('tells keys, values and comments apart in YAML', async () => {
    const found = await classesOf('application.yml', '# comment\nserver:\n  port: 8080\n')
    const [comment, key, value] = [found.get('# comment'), found.get('port'), found.get('8080')]
    expect(comment && key && value).toBeTruthy()
    expect(new Set([comment, key, value]).size).toBe(3)
  })
})
