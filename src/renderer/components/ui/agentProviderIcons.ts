import { RiOpenaiLine, RiPlanetLine } from 'react-icons/ri'
import { SiClaude } from 'react-icons/si'

export const AGENT_PROVIDER_ICONS = { codex: RiOpenaiLine, claude: SiClaude, antigravity: RiPlanetLine } as const
export { AGENT_PROVIDER_NAMES } from '../../lib/agentIdentity'
