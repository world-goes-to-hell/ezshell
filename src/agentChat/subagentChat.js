const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const CODEX_PATH = /^\/root\/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/i

function routeSubagent(kind, child, identity, active) {
  // Binding comes from the parent transcript and the matching child's own metadata.
  const path = kind === 'codex' && [identity.path, ...child.keys].find(key => CODEX_PATH.test(key ?? ''))
  const id = kind === 'claude' ? identity.id : path || [identity.id, ...child.keys].find(key => UUID.test(key ?? ''))
  const label = kind === 'claude'
    ? child.uniqueTask ? identity.description || child.task : null
    : !path && !identity.parentOwned && child.uniqueName && identity.nickname && identity.role
      ? `${identity.nickname} [${identity.role}]` : null
  if (!id) return { mode: 'read-only' }
  if (label && active === label) return { mode: 'direct', target: label }
  // The terminal reports an empty label for the parent and null for an unidentified composer.
  if (active !== '') return { mode: 'select-parent' }
  return { mode: 'relay', target: '', id, kind }
}

function subagentRelayText(route, text) {
  const message = JSON.stringify(text)
  const tool = route.kind === 'claude' ? 'SendMessage' : route.id.startsWith('/') ? 'followup_task' : 'send_input'
  return `Send a follow-up to the existing subagent ${JSON.stringify(route.id)} using ${tool}. Pass this message as written, without starting another agent or doing the task yourself. Tell me if delivery fails.\nMessage (JSON string): ${message}`
}

module.exports = { routeSubagent, subagentRelayText }
