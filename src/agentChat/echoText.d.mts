type EchoText = { text: string; hasImage?: boolean }

export function matchesEchoText(recorded: { text?: string; hasImage?: boolean }, sent: EchoText, relaxed: boolean): boolean
