import { createContext } from 'react'
import type { GroupProject } from '../../lib/tabGroups'

export const HandoffProjectsContext = createContext<readonly GroupProject[]>([])
