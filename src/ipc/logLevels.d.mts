export type LogLevel = 'error' | 'warn' | 'debug' | 'marker'
export type JumpLevel = 'error' | 'warn'
export interface LineClass { level: LogLevel | null; explicit: boolean }
export function markerLine(text: string): string
export function isFrameSource(previousLine: string, line: string): boolean
export function classifyDetail(line: string): LineClass
export function classifyLine(line: string): LogLevel | null
export function classifyProblemLine(line: string, previous: string, inside: boolean): { level: JumpLevel | null; start: boolean; inside: boolean }
