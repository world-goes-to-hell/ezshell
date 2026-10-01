const DEFAULT_SSH_PORT = 22

interface HostInfo {
  username: string
  host: string
  port: number
}

/** "user@host" (with ":port" when not 22) for a popped-out window's title bar */
export function formatHostLabel(info: HostInfo | null): string {
  if (!info || !info.host) return ''
  const port = info.port && info.port !== DEFAULT_SSH_PORT ? `:${info.port}` : ''
  return `${info.username ? `${info.username}@` : ''}${info.host}${port}`
}
