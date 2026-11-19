import { useEffect, useState } from 'react'
import { LOCAL_PROJECT_SERVERS_EVENT, readProjectServers, type ProjectServers } from '../lib/localProjectServers'

/** Saved sessions linked to local projects; follows changes made by the tree or the session menu */
export function useProjectServers(): ProjectServers {
  const [servers, setServers] = useState<ProjectServers>(readProjectServers)
  useEffect(() => {
    const onChange = () => setServers(readProjectServers())
    window.addEventListener(LOCAL_PROJECT_SERVERS_EVENT, onChange)
    return () => window.removeEventListener(LOCAL_PROJECT_SERVERS_EVENT, onChange)
  }, [])
  return servers
}
