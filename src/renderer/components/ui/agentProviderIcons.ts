import { RiOpenaiLine, RiPlanetLine } from 'react-icons/ri'
import { SiClaude } from 'react-icons/si'

export const AGENT_PROVIDER_ICONS = { codex: RiOpenaiLine, claude: SiClaude, antigravity: RiPlanetLine } as const
export const AGENT_PROVIDER_NAMES = { codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' } as const
