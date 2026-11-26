const path = require('node:path')
const { isLocalFilePath } = require('./localKeyPath.js')

// The agents of one project, for the screens that send work to an agent (quick capture, the browser tab's
// element request). A project is a repository's main checkout, so its linked worktrees come under it; a
// folder outside Git is a project of its own.

const MAX_FOLDER = 4096
const keyOf = folder => path.normalize(folder).toLowerCase()

// A folder name alone is often generic (backend, frontend), so the parent folder comes with it: "shop / backend".
function projectName(folder) {
  const name = path.basename(folder)
  if (!name) return folder
  const parent = path.basename(path.dirname(folder))
  return parent ? `${parent} / ${name}` : name
}

/** `repoFolders(folder)` gives the repository top and then its worktrees, the main checkout first ([] outside Git) */
async function projectFolder(folder, repoFolders) {
  const [top, main] = await repoFolders(folder)
  return main ?? top ?? folder
}

async function agentProjects(agents, repoFolders) {
  const folders = new Map()
  const projects = new Map()
  const locations = await Promise.all(agents.map(agent => {
    const key = keyOf(agent.cwd)
    if (!folders.has(key)) folders.set(key, projectFolder(agent.cwd, repoFolders))
    return folders.get(key)
  }))
  agents.forEach((agent, index) => {
    const folder = locations[index]
    const key = keyOf(folder)
    if (!projects.has(key)) projects.set(key, { folder, name: projectName(folder), agents: [] })
    projects.get(key).agents.push(agent)
  })
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.folder.localeCompare(b.folder, 'ko'))
}

/**
 * The listed project a folder belongs to, or null. The folder comes from the screen (where a browser tab was
 * opened), so only a local absolute path is looked up: Git never runs on a network or device path.
 */
async function preferredProject(projects, folder, repoFolders) {
  if (typeof folder !== 'string' || folder.length > MAX_FOLDER || !isLocalFilePath(folder) || !path.isAbsolute(folder)) return null
  const key = keyOf(await projectFolder(folder, repoFolders).catch(() => folder))
  return projects.find(project => keyOf(project.folder) === key)?.folder ?? null
}

module.exports = { agentProjects, projectFolder, preferredProject, projectName }
