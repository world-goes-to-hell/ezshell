// The slash commands a user made for the agent (not the built-in ones: lib/slashCommands.ts has those),
// for the chat composer's list. Names and one-line descriptions only; no path or file content goes to
// the window.
// - Claude Code: `commands/**/*.md` and `skills/<name>/SKILL.md`, in the user's folder
//   ($CLAUDE_CONFIG_DIR, else ~/.claude) and in the project (`<cwd>/.claude`).
// - Codex: `prompts/*.md` in $CODEX_HOME (else ~/.codex), run as `/prompts:<name>`.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { isLocalFilePath } = require('../localKeyPath.js')

const MAX_COMMANDS = 300
const MAX_DEPTH = 3
const HEAD_BYTES = 4096
const NAME = /^[\w.:-]{1,64}$/

/** The front matter's `key: value` of a file's first bytes */
async function frontMatter(file) {
  let handle
  try {
    handle = await fs.promises.open(file, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    const head = buffer.subarray(0, bytesRead).toString('utf8').replace(/^﻿/, '')
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)
    const fields = {}
    if (block) {
      let folded = null
      for (const line of block[1].split(/\r?\n/)) {
        // A block value ("description: |" then indented lines)
        if (folded && /^\s+\S/.test(line)) { fields[folded] = (fields[folded] + ' ' + line.trim()).trim(); continue }
        folded = null
        const field = /^([\w-]+):\s*(.*)$/.exec(line)
        if (!field) continue
        const key = field[1].toLowerCase()
        const value = field[2].trim()
        if (/^[|>][-+]?$/.test(value)) { fields[key] = ''; folded = key } else fields[key] = value.replace(/^(['"])(.*)\1$/, '$2')
      }
    }
    return fields
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)

async function markdownFiles(dir, depth = 0) {
  let entries
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return [] }
  const files = []
  for (const entry of entries) {
    // Links are not followed: a link could lead anywhere on the PC
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path.join(dir, entry.name))
    else if (entry.isDirectory() && depth < MAX_DEPTH && !entry.name.startsWith('.')) files.push(...await markdownFiles(path.join(dir, entry.name), depth + 1))
  }
  return files
}

async function claudeFolder(root, source, add) {
  for (const file of await markdownFiles(path.join(root, 'commands'))) {
    const fields = await frontMatter(file)
    if (fields) add(path.basename(file, path.extname(file)), fields.description, source)
  }
  let skills
  try { skills = await fs.promises.readdir(path.join(root, 'skills'), { withFileTypes: true }) } catch { skills = [] }
  for (const entry of skills) {
    if (!entry.isDirectory()) continue
    const fields = await frontMatter(path.join(root, 'skills', entry.name, 'SKILL.md'))
    if (!fields || fields['user-invocable'] === 'false') continue
    add(fields.name || entry.name, fields.description, source)
  }
}

/**
 * [{ name: '/q-copy', description, source: 'user' | 'project' }], sorted by name
 * cwd: the agent's working folder (the project's commands), local paths only
 */
async function customCommands({ kind, cwd, claudeRoot, env = process.env, home = os.homedir() }) {
  const found = new Map()
  const add = (name, description, source) => {
    const command = kind === 'codex' ? `prompts:${name}` : name
    if (!NAME.test(command) || found.size >= MAX_COMMANDS || found.has(command)) return
    found.set(command, { name: '/' + command, description: oneLine(description), source })
  }
  if (kind === 'claude') {
    // The project's first: the CLI prefers them over the user's of the same name
    if (typeof cwd === 'string' && isLocalFilePath(cwd)) await claudeFolder(path.join(cwd, '.claude'), 'project', add)
    if (claudeRoot !== null) await claudeFolder(claudeRoot || env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'user', add)
  } else if (kind === 'codex') {
    const dir = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'prompts')
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { entries = [] }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      const fields = await frontMatter(path.join(dir, entry.name))
      if (fields) add(path.basename(entry.name, path.extname(entry.name)), fields.description, 'user')
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

module.exports = { customCommands, frontMatter }
