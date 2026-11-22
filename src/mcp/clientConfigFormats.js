const { isDeepStrictEqual } = require('node:util')
const { parseTree, getNodeValue, modify, applyEdits } = require('jsonc-parser')
const { parseTOML, getStaticTOMLValue } = require('toml-eslint-parser')
const { SetupError, detectIndent, isPlainObject } = require('./clientSetup.js')

function readJsonConfig(text, filePath, allowJsonc) {
  const errors = []
  const root = parseTree(text, errors, { allowTrailingComma: allowJsonc, disallowComments: !allowJsonc })
  if (errors.length || root?.type !== 'object') throw new SetupError(`${filePath} 의 JSON 형식이 올바르지 않습니다.`)
  return root
}

function jsonProperty(node, key, filePath) {
  if (!node) return undefined
  if (node.type !== 'object') throw new SetupError(`${filePath} 의 MCP 설정이 객체가 아닙니다.`)
  const properties = node.children.filter(property => property.children[0].value === key)
  if (properties.length > 1) throw new SetupError(`${filePath} 에 중복된 ${key} 항목이 있습니다.`)
  return properties[0]?.children[1]
}

// Older OpenCode versions also accept a direct server named "servers".
function directOpenCodeServer(node) {
  return node?.type === 'object' && node.children.some(({ children: [key, value] }) =>
    (key.value === 'type' && value.type === 'string') || (key.value === 'enabled' && value.type === 'boolean'))
}

function jsonRegistration(text, filePath, client, name) {
  const allowJsonc = client === 'opencode' || client === 'cursor'
  const body = text.trim() ? text : '{}'
  const root = readJsonConfig(body, filePath, allowJsonc)
  let address = ['mcpServers', name]
  if (client === 'opencode') {
    const mcp = jsonProperty(root, 'mcp', filePath)
    const servers = jsonProperty(mcp, 'servers', filePath)
    const modern = servers && !directOpenCodeServer(servers) ? servers : undefined
    const legacy = jsonProperty(mcp, name, filePath)
    // Preserve the layout of existing OpenCode configs. New files use its current schema.
    if (legacy && jsonProperty(modern, name, filePath)) throw new SetupError(`${filePath} 에 중복된 ${name} 항목이 있습니다.`)
    const legacyLayout = legacy || (!modern && mcp?.children.some(property => directOpenCodeServer(property.children[1])))
    address = legacyLayout ? ['mcp', name] : ['mcp', 'servers', name]
  }
  const existing = address.reduce((node, key) => jsonProperty(node, key, filePath), root)
  return {
    existing: existing ? JSON.parse(JSON.stringify(getNodeValue(existing))) : undefined,
    edit: entry => {
      const indent = detectIndent(body)
      const eol = body.includes('\r\n') ? '\r\n' : '\n'
      const options = { formattingOptions: { insertSpaces: indent !== '\t', tabSize: indent === '\t' ? 1 : indent, eol } }
      const edited = applyEdits(body, modify(body, address, entry, options))
      readJsonConfig(edited, filePath, allowJsonc)
      return edited.endsWith('\n') ? edited : edited + eol
    }
  }
}

const MCP_TABLE = 'mcp_servers'
const tomlKey = node => node.name ?? node.value

function readTomlConfig(text, filePath) {
  try {
    const ast = parseTOML(text)
    const doc = getStaticTOMLValue(ast)
    if (doc[MCP_TABLE] !== undefined && !isPlainObject(doc[MCP_TABLE])) throw new Error()
    return { ast, doc }
  } catch {
    throw new SetupError(`${filePath} 의 TOML 형식이나 MCP 설정이 올바르지 않습니다.`)
  }
}

// The entry holds strings, booleans or inline tables of strings.
function tomlValue(value) {
  if (!isPlainObject(value)) return JSON.stringify(value)
  return `{ ${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)} = ${tomlValue(child)}`).join(', ')} }`
}

function editTomlRegistration(text, ast, name, entry) {
  const edits = []
  const target = keys => keys[0] === MCP_TABLE && keys[1] === name
  const visitKey = (node, parent) => {
    const keys = parent.concat(node.key.keys.map(tomlKey))
    if (target(keys)) edits.push({ range: node.range, text: '' })
  }
  for (const node of ast.body[0].body) {
    if (node.type === 'TOMLTable') {
      if (target(node.resolvedKey)) edits.push({ range: node.range, text: '' })
      else if (node.resolvedKey[0] === MCP_TABLE) node.body.forEach(child => visitKey(child, node.resolvedKey))
      continue
    }
    if (node.key.keys.length === 1 && tomlKey(node.key.keys[0]) === MCP_TABLE && node.value.type === 'TOMLInlineTable') {
      const remaining = node.value.body
        .filter(child => tomlKey(child.key.keys[0]) !== name)
        .map(child => text.slice(...child.range))
      remaining.push(`${name} = ${tomlValue(entry)}`)
      return text.slice(0, node.value.range[0]) + `{ ${remaining.join(', ')} }` + text.slice(node.value.range[1])
    }
    visitKey(node, [])
  }

  // Edits are in source order. Leave unrelated values, comments and formatting in place.
  let edited = text
  for (const { range } of edits.reverse()) edited = edited.slice(0, range[0]) + edited.slice(range[1])
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const section = [`[${MCP_TABLE}.${name}]`, ...Object.entries(entry).map(([key, value]) => `${key} = ${tomlValue(value)}`)].join(eol)
  return (edited.trim() ? edited.trimEnd() + eol + eol : '') + section + eol
}

function tomlRegistration(text, filePath, name) {
  const { ast, doc } = readTomlConfig(text, filePath)
  return {
    existing: Object.hasOwn(doc[MCP_TABLE] ?? {}, name) ? doc[MCP_TABLE][name] : undefined,
    edit: entry => {
      const edited = editTomlRegistration(text, ast, name, entry)
      const updated = readTomlConfig(edited, filePath).doc
      const expected = { ...doc, [MCP_TABLE]: { ...doc[MCP_TABLE], [name]: entry } }
      if (!isDeepStrictEqual(updated, expected)) throw new SetupError(`${filePath} 의 다른 설정을 보존할 수 없어 저장하지 않았습니다.`)
      return edited
    }
  }
}

module.exports = { jsonRegistration, tomlRegistration }
