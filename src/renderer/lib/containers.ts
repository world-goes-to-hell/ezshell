// The container panel's data and the commands it puts on the terminal's input line.
// The app runs none of these commands itself: they are typed for the user, who presses Enter.

export interface ContainerInfo {
  id: string
  name: string
  image: string
  status: string
  state: string
  ports: string
}

export type ContainerListResult =
  | { kind: 'list'; containers: ContainerInfo[]; truncated: boolean }
  | { kind: 'no-docker' }
  | { kind: 'no-permission' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string }

/** Same rule as the main process (src/containers/parse.js): the name goes into a command line */
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
export const isContainerName = (value: string): boolean => CONTAINER_NAME.test(value)

export type ContainerAction = 'shell' | 'restart' | 'stop' | 'start'

/** The command for the input line, or null when the name could not be typed safely */
export function containerCommand(action: ContainerAction, name: string): string | null {
  if (!isContainerName(name)) return null
  switch (action) {
    // sh exists in nearly every image; bash does not
    case 'shell': return `docker exec -it ${name} sh`
    case 'restart': return `docker restart ${name}`
    case 'stop': return `docker stop ${name}`
    case 'start': return `docker start ${name}`
  }
}

export const isRunning = (container: ContainerInfo): boolean =>
  container.state ? container.state === 'running' : /^up\b/i.test(container.status)

/** "0.0.0.0:8080->80/tcp, :::8080->80/tcp" -> "8080→80"; internal-only ports are left out */
export function publishedPorts(ports: string): string {
  const seen: string[] = []
  for (const part of ports.split(',')) {
    const match = /:(\d+(?:-\d+)?)->(\d+(?:-\d+)?)/.exec(part)
    if (!match) continue
    const label = `${match[1]}→${match[2]}`
    if (!seen.includes(label)) seen.push(label)
  }
  return seen.join(', ')
}

export const CONTAINER_AUTO_REFRESH_MS = 10_000
