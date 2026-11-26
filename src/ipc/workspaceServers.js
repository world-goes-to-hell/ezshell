const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { isLocalFilePath } = require('../localKeyPath.js')
const { resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { sameOrInside } = require('../localFiles/roots.js')
const { parseXml } = require('../sessionImport/filezilla.js')

const MAX_XML = 256 * 1024
const MAX_GRANTS = 1024 * 1024
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u
const CONTEXT_ELEMENTS = new Set(['Resource', 'Environment', 'Parameter'])
const LAUNCHES = '.metadata/.plugins/org.eclipse.debug.core/.launches'
const BAD_CONTEXT = '프로젝트 또는 직접 선택한 이클립스 워크스페이스 안의 컨텍스트 XML을 선택해 주세요.'
const canonical = value => resolveLocalPreviewPath(value).catch(() => null)
const equalPath = (a, b) => path.relative(a, b) === ''
const pathParts = value => value.split(/[\\/]+/)
const validAbsolute = value => path.isAbsolute(value) && isLocalFilePath(value) && !CONTROL.test(value) &&
  !pathParts(value.slice(path.parse(value).root.length)).some(part => part.includes(':') || part === '..' || part.toLowerCase() === '.git')

function normalizeContextReference(value, relative) {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 4096 || !/\.xml$/i.test(value) || CONTROL.test(value)) throw new Error(BAD_CONTEXT)
  if (path.isAbsolute(value)) {
    if (!validAbsolute(value)) throw new Error(BAD_CONTEXT)
    return path.normalize(value)
  }
  return relative(value)
}

async function readXml(file) {
  const handle = await fsp.open(file, 'r')
  try {
    const bytes = Buffer.alloc(MAX_XML + 1)
    const count = (await handle.read(bytes, 0, bytes.length, 0)).bytesRead
    if (count > MAX_XML) throw new Error('XML 설정 파일이 너무 큽니다.')
    return parseXml(bytes.toString('utf8', 0, count))
  } finally { await handle.close() }
}

function createWorkspaceAccess(file) {
  function read() {
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.size > MAX_GRANTS) return new Map()
      return new Map(JSON.parse(fs.readFileSync(file, 'utf8')).filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])))
    } catch { return new Map() }
  }

  async function selectedRoot(folder) {
    if (typeof folder !== 'string' || !validAbsolute(folder)) throw new Error('이 PC의 이클립스 워크스페이스 폴더를 선택해 주세요.')
    const entry = await canonical(folder)
    if (!entry?.stat.isDirectory() || !validAbsolute(entry.path)) throw new Error('이클립스 워크스페이스 폴더를 열 수 없습니다.')
    return entry.path
  }

  function grant(project, root) {
    const grants = read()
    const previous = grants.get(project.key) ?? []
    grants.set(project.key, [...previous.filter(folder => typeof folder === 'string' && !equalPath(folder, root)), root])
    const contents = JSON.stringify([...grants])
    if (Buffer.byteLength(contents) > MAX_GRANTS) throw new Error('등록된 이클립스 워크스페이스 경로가 너무 많습니다.')
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, file)
    } finally { try { fs.unlinkSync(temporary) } catch { /* Renamed or absent. */ } }
  }

  async function contextFile(project, reference) {
    const absolute = path.isAbsolute(reference) ? reference : path.join(project.worktree, reference)
    if (!validAbsolute(absolute)) throw new Error(BAD_CONTEXT)
    const roots = [project.worktree, ...(read().get(project.key) ?? []).filter(root => typeof root === 'string' && validAbsolute(root))]
    const root = roots.find(root => sameOrInside(root, absolute))
    if (!root) throw new Error(BAD_CONTEXT)
    const owner = await canonical(root)
    if (!owner?.stat.isDirectory() || !equalPath(root, owner.path)) throw new Error(BAD_CONTEXT)
    const entry = await canonical(absolute)
    if (!entry?.stat.isFile() || !validAbsolute(entry.path) || !sameOrInside(root, entry.path) || !/\.xml$/i.test(entry.path)) throw new Error(BAD_CONTEXT)
    const value = equalPath(root, project.worktree) ? path.relative(root, entry.path).split(path.sep).join('/') : entry.path
    return { file: entry.path, reference: value }
  }

  async function contextEntries(project, reference) {
    const { file } = await contextFile(project, reference)
    let xml
    try { xml = await readXml(file) } catch { throw new Error('컨텍스트 XML을 읽을 수 없거나 크기 제한을 넘었습니다.') }
    if (xml?.name !== 'Context') throw new Error('컨텍스트 XML에서 Context 항목을 찾을 수 없습니다.')
    return xml.children.filter(node => CONTEXT_ELEMENTS.has(node.name))
      .map(({ name, attrs }) => ({ name, attrs, children: [], text: '' }))
  }

  return { selectedRoot, grant, contextFile, contextEntries }
}

async function fixedEntry(root, relative, directory = false) {
  const file = path.join(root, relative)
  const entry = await canonical(file)
  if (!entry || !equalPath(file, entry.path) || !(directory ? entry.stat.isDirectory() : entry.stat.isFile())) return null
  return entry.path
}

async function optionalXml(root, relative, notes) {
  const entry = await fixedEntry(root, relative)
  if (!entry) return null
  try { return await readXml(entry) } catch { notes.push(`이클립스 XML을 읽지 못했습니다. ${path.basename(relative)}`); return null }
}

async function workspaceServers(root, { launchArguments, validContextPath }) {
  const notes = []
  const servers = await fixedEntry(root, 'Servers', true)
  if (!servers) return { servers: [], notes: ['선택한 폴더에서 Servers 프로젝트를 찾지 못했습니다.'] }
  const launchDirectory = await fixedEntry(root, LAUNCHES, true)
  const launches = new Map()
  if (launchDirectory) {
    const entries = await fsp.readdir(launchDirectory, { withFileTypes: true })
    for (const entry of entries.filter(candidate => candidate.isFile() && /\.launch$/i.test(candidate.name)).slice(0, 96)) {
      const xml = await optionalXml(root, path.join(LAUNCHES, entry.name), notes)
      const attributes = xml?.name === 'launchConfiguration' ? xml.children.filter(node => node.name === 'stringAttribute') : []
      const settings = new Map(attributes.map(node => [node.attrs.key, node.attrs.value]))
      const args = settings.get('org.eclipse.jdt.launching.VM_ARGUMENTS')
      if (!args) continue
      const name = settings.get('org.eclipse.jst.server.core.SERVER_ID') ?? settings.get('server-id') ?? path.basename(entry.name, path.extname(entry.name))
      launches.set(name, args)
    }
  }
  const imported = []
  let omittedCredentials = 0
  const folders = await fsp.readdir(servers, { withFileTypes: true })
  for (const folder of folders.filter(entry => entry.isDirectory() && /-config$/.test(entry.name) && !CONTROL.test(entry.name)).slice(0, 48)) {
    const relative = path.join('Servers', folder.name)
    const server = await optionalXml(root, path.join(relative, 'server.xml'), notes)
    if (server?.name !== 'Server') continue
    const name = folder.name.slice(0, -'-config'.length)
    const services = server.children.filter(node => node.name === 'Service')
    const connector = services.flatMap(s => s.children).find(node => node.name === 'Connector' && /^HTTP\/|^org\.apache\.coyote\.http11\.|^$/i.test(node.attrs.protocol ?? '') && node.attrs.SSLEnabled !== 'true')
    const portNumber = Number(connector?.attrs.port)
    const hostContexts = services.flatMap(s => s.children.filter(node => node.name === 'Engine'))
      .flatMap(engine => engine.children.filter(node => node.name === 'Host')).flatMap(host => host.children.filter(node => node.name === 'Context'))
    const contextPath = hostContexts.length === 1 ? hostContexts[0].attrs.path || '/' : undefined
    const reference = path.join(relative, 'context.xml')
    const context = await optionalXml(root, reference, notes)
    const raw = launches.get(name)
    let vmArgs
    if (raw) {
      try {
        const result = launchArguments(raw)
        vmArgs = result.vmArgs
        omittedCredentials += result.omittedCredentials
      } catch { notes.push(`VM 인자를 가져오지 못했습니다. ${name}`) }
    }
    imported.push({ name, ...(Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65536 && { port: portNumber }),
      ...(validContextPath(contextPath) && { contextPath }), ...(vmArgs !== undefined && { vmArgs }),
      ...(context?.name === 'Context' && { contextXml: path.join(root, reference) }) })
  }
  if (omittedCredentials) notes.push(`자격 증명으로 보이는 VM 인자 ${omittedCredentials}개를 건너뛰었습니다.`)
  return { servers: imported, notes }
}

module.exports = { createWorkspaceAccess, normalizeContextReference, workspaceServers }
