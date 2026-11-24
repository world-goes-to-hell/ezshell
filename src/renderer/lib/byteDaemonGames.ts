// Byte Daemon: rules of the three mini games (docs/plan/2026-11-24-byte-daemon-mini-game.md)
import { gameUnit } from './byteDaemon'

export const COMBO_MAX = 9

// ---------- catch the bug ----------

export type LogLevel = 'info' | 'warn' | 'error'
export const catchSeconds = 30
export const BUG_POINTS: Record<'warn' | 'error', number> = { warn: 20, error: 40 }
export const INFO_PENALTY = 10
/** A good round, paid as one game */
export const CATCH_TARGET = 800

const lerp = (from: number, to: number, elapsedMs: number) => from + (to - from) * Math.min(1, Math.max(0, elapsedMs / (catchSeconds * 1000)))

/** How often a new log line arrives: faster as the round goes on */
export const lineIntervalMs = (elapsedMs: number) => Math.round(lerp(820, 380, elapsedMs))

/** How long a bug takes to crawl across its line; a container makes bugs 15% slower */
export const crawlMs = (elapsedMs: number, slower: boolean) => Math.round(lerp(6500, 3400, elapsedMs) / (slower ? 0.85 : 1))

export const catchFactor = (score: number) => Math.max(0, score) / CATCH_TARGET

const INFO_LINES = [
  '[api] GET /health 200 3ms', '[api] POST /login 200 41ms', '[cache] hit ratio 0.93', '[cron] backup.sh done',
  '[api] GET /items 200 12ms', '[auth] token refreshed', '[web] served index.html', '[queue] 12 jobs drained',
  '[db] pool size 20', '[api] GET /users/42 200 8ms', '[ws] client connected', '[cron] backup.sh started'
]
const WARN_LINES = [
  '[db] slow query 1.2s', '[disk] /var 87% used', '[api] retry 2/3 upstream', '[mem] heap 81%',
  '[tls] cert expires in 9 days', '[queue] backlog 340'
]
const ERROR_LINES = [
  '[worker] NullPointerException', '[api] 502 Bad Gateway', '[deploy] health check failed', '[db] connection refused',
  '[app] OutOfMemoryError', '[api] TypeError: undefined', '[auth] invalid signature', '[job] exit code 137'
]

const pick = <T,>(items: readonly T[], rand: () => number) => items[Math.min(items.length - 1, Math.floor(rand() * items.length))]

export function randomLine(rand: () => number = Math.random): { level: LogLevel; text: string } {
  const roll = rand()
  if (roll < 0.2) return { level: 'error', text: pick(ERROR_LINES, rand) }
  if (roll < 0.42) return { level: 'warn', text: pick(WARN_LINES, rand) }
  return { level: 'info', text: pick(INFO_LINES, rand) }
}

// ---------- command typing ----------

export const COMMANDS: readonly string[] = [
  'ls -la', 'git status', 'docker compose up -d', 'git rebase -i HEAD~3', 'kubectl get pods -A', 'tail -f /var/log/app.log',
  'npm run build', 'ssh deploy@prod', 'grep -rn TODO src', 'git push --force-with-lease', 'docker ps -a', 'cd ~/project',
  'chmod +x run.sh', 'systemctl restart nginx', 'df -h', 'du -sh *', 'git log --oneline', 'npm install', 'ps aux | grep node',
  'curl -I localhost:8080', 'git checkout -b fix/login', 'kubectl logs -f web-0', 'make test', 'cat .gitignore',
  'git stash pop', 'docker image prune', 'journalctl -u app', 'export NODE_ENV=prod', 'mkdir -p logs/old', 'top -o cpu'
]

export const typingSeconds = (cron: boolean) => cron ? 35 : 30
/** Correct characters in a good round (about 240 a minute) */
export const TYPING_TARGET = 120
export const typingFactor = (correct: number) => Math.max(0, correct) / TYPING_TARGET
export const charsPerMinute = (correct: number, elapsedMs: number) => elapsedMs > 0 ? Math.round(correct / (elapsedMs / 60000)) : 0

/** US layout: the character of a key place, plain and with Shift */
const PLACES: Record<string, [string, string]> = {
  Space: [' ', ' '], Minus: ['-', '_'], Equal: ['=', '+'], BracketLeft: ['[', '{'], BracketRight: [']', '}'],
  Backslash: ['\\', '|'], Semicolon: [';', ':'], Quote: ["'", '"'], Comma: [',', '<'], Period: ['.', '>'],
  Slash: ['/', '?'], Backquote: ['`', '~'],
  Digit1: ['1', '!'], Digit2: ['2', '@'], Digit3: ['3', '#'], Digit4: ['4', '$'], Digit5: ['5', '%'],
  Digit6: ['6', '^'], Digit7: ['7', '&'], Digit8: ['8', '*'], Digit9: ['9', '('], Digit0: ['0', ')']
}

/**
 * The character a key types, or null for keys that type nothing. With a Korean input method on,
 * the key is 'Process' or a Hangul letter, so the place (`code`) decides: commands are ASCII.
 */
export function keyChar(event: { key: string; code: string; shiftKey: boolean; isComposing: boolean }): string | null {
  if (!event.isComposing && event.key.length === 1 && event.key >= ' ' && event.key <= '~') return event.key
  const letter = /^Key([A-Z])$/.exec(event.code)
  if (letter) return event.shiftKey ? letter[1] : letter[1].toLowerCase()
  const place = PLACES[event.code]
  return place ? place[event.shiftKey ? 1 : 0] : null
}

// ---------- friday deploy ----------

export interface DeployStep {
  name: string
  sub: string
  art: 'hammer' | 'flask' | 'server' | 'rocket'
  mult: number
  /** Chance of a rollback, % */
  risk: number
}

/** Close to an even bet when stopping anywhere (about 1.1x): a gamble, not a better way to earn */
export const DEPLOY_STEPS: readonly DeployStep[] = [
  { name: '빌드', sub: 'npm run build', art: 'hammer', mult: 1.2, risk: 10 },
  { name: '테스트', sub: '단위·화면 테스트', art: 'flask', mult: 1.5, risk: 20 },
  { name: '스테이징', sub: '검증 서버', art: 'server', mult: 2.5, risk: 35 },
  { name: '운영', sub: '진짜 서버', art: 'rocket', mult: 5, risk: 50 }
]

export const isFridayEvening = (date: Date) => date.getDay() === 5 && date.getHours() >= 18

export const deployRisk = (step: DeployStep, { duck, fridayEvening }: { duck: boolean; fridayEvening: boolean }) =>
  Math.min(95, Math.max(1, step.risk - (duck ? 5 : 0) + (fridayEvening ? 10 : 0)))

/** The stake: half a game at most, from the bytes there are; 0 when that is under 10 B */
export function deployStake(bytes: number, rate: number) {
  const stake = Math.floor(Math.min(bytes, gameUnit(rate) / 2))
  return stake >= 10 ? stake : 0
}
