import { z } from 'zod'
import {
  sealSecrets, openSecrets, secretBoxSchema, bytesToBase64Url, base64UrlToBytes, ShareUnlockError,
  type SecretBox
} from './shareCrypto'

/**
 * Session (or folder of sessions) connection info as text people can paste into a messenger: a
 * readable first line and a token line the app reads.
 *
 *   ezshell-session:v1:<base64url JSON>[.<base64url sealed passwords>]
 *
 * The JSON is `{ session }` or `{ folder }` and never holds a password. Passwords travel only in the
 * second part, sealed with a passphrase the sender picks (lib/shareCrypto). Text from someone else is
 * untrusted, so the parser keeps only known fields, checks each one, and never brings in MCP access,
 * key paths or ids.
 */
export const SHARE_PREFIX = 'ezshell-session:v1:'
export const MAX_TOKEN_LENGTH = 2 * 1024 * 1024
export const MAX_SHARED_FOLDERS = 200
export const MAX_SHARED_SESSIONS = 1000
export const MAX_FOLDER_DEPTH = 10
// Decoded size and object count are checked before zod walks the tree (a crafted token must not freeze the window)
const MAX_PLAIN_LENGTH = 1024 * 1024
const MAX_NODES = 20_000
const TOKEN_PATTERN = /ezshell-session:v(\d+):([A-Za-z0-9_-]*)(?:\.([A-Za-z0-9_-]+))?/

/** What travels for one session (secrets only after unlockShare) */
export interface SharedSession {
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  passphrase?: string
  backgroundColor?: string
  connectTimeout?: number
  keepaliveInterval?: number
  autoReconnect?: boolean
  postConnectScript?: string
  suRoot?: boolean
  suPassword?: string
  useJumpHost?: boolean
  jumpHost?: string
  jumpPort?: number
  jumpUsername?: string
  jumpAuthType?: 'password' | 'privateKey'
  jumpPassword?: string
  jumpPassphrase?: string
}

/** A folder with its sub-folders and sessions */
export interface SharedFolder {
  name: string
  backgroundColor?: string
  folders: SharedFolder[]
  sessions: SharedSession[]
}

/** The fields of a saved session this module reads (a Session or ConnectionConfig fits) */
export type ShareSource = Partial<Record<keyof SharedSession, unknown>> & {
  id?: string; name?: string; host: string; port: number; username: string; folderId?: string
}

export interface ShareFolderSource {
  id: string
  name: string
  parentId?: string
  backgroundColor?: string
}

/** Sealed passwords and the plain part they are bound to; opened by unlockShare */
export interface LockedSecrets { box: SecretBox; aad: string }

type ParsedOk =
  | { ok: true; kind: 'session'; session: SharedSession; hasSecrets: boolean; locked?: LockedSecrets }
  | { ok: true; kind: 'folder'; folder: SharedFolder; hasSecrets: boolean; locked?: LockedSecrets; folderCount: number; sessionCount: number }

export type ParseResult = ParsedOk | { ok: false; error: string }

export interface ShareOptions {
  /** Seal the passwords with this passphrase. Without it no password is written. */
  passphrase?: string
}

const SECRET_KEYS = ['password', 'passphrase', 'suPassword', 'jumpPassword', 'jumpPassphrase'] as const
type SessionSecrets = Partial<Pick<SharedSession, typeof SECRET_KEYS[number]>>

// C0/C1 controls, line/paragraph separators and invisible format characters (bidi overrides, zero
// width): in a name or address they make the preview show something other than what is saved
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u
const CONTROL_RUN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]+/gu
// The start-up script may have line breaks and tabs only. A lone CR would run as Enter on the server
// while the preview shows one line, so CRLF becomes LF first and any other CR is refused.
const SCRIPT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u
const CONTROL_MESSAGE = '줄바꿈이나 제어 문자가 들어 있습니다'

const noControl = (value: string) => !CONTROL.test(value)

/** One-line text: control characters are refused before trimming (a trailing newline must not vanish) */
const line = (max: number) => z.string().max(max * 2)
  .refine(noControl, CONTROL_MESSAGE)
  .transform(value => value.trim())
  .pipe(z.string().max(max))

const address = (max: number) => line(max).pipe(z.string().min(1).regex(/^\S+$/, '공백이 들어 있습니다'))
const secret = z.string().max(1000).refine(noControl, CONTROL_MESSAGE).optional()
const authType = z.enum(['password', 'privateKey'])
const port = z.number().int().min(1).max(65535)
const color = z.string().regex(/^#[0-9a-fA-F]{3,8}$/)
const loose = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined)

/** Copies only the values that say something (no undefined, no empty strings) */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== '')
  ) as T
}

// No password fields: a plain password in someone's text is dropped like any unknown field
const sessionSchema = z.object({
  name: line(100).optional(),
  host: address(253),
  port,
  username: address(64),
  authType,
  backgroundColor: loose(color),
  connectTimeout: loose(z.number().int().min(1).max(300)),
  keepaliveInterval: loose(z.number().int().min(0).max(3600)),
  autoReconnect: loose(z.boolean()),
  postConnectScript: z.string().max(4000).transform(value => value.replace(/\r\n/g, '\n'))
    .refine(value => !SCRIPT_CONTROL.test(value), '자동 실행 스크립트에 제어 문자가 들어 있습니다').optional(),
  suRoot: loose(z.boolean()),
  useJumpHost: loose(z.boolean()),
  jumpHost: address(253).optional(),
  jumpPort: port.optional(),
  jumpUsername: address(64).optional(),
  jumpAuthType: authType.optional()
}).transform((value): SharedSession => {
  // "use a jump host" without an address would save a session the preview does not show as jumping
  const jump = value.useJumpHost === true && Boolean(value.jumpHost)
  const kept = compact({
    ...value,
    useJumpHost: jump || undefined,
    jumpHost: jump ? value.jumpHost : undefined,
    jumpPort: jump ? value.jumpPort : undefined,
    jumpUsername: jump ? value.jumpUsername : undefined,
    jumpAuthType: jump ? value.jumpAuthType : undefined
  })
  return { ...kept, name: kept.name || `${kept.username}@${kept.host}` }
})

const folderSchema: z.ZodType<SharedFolder, z.ZodTypeDef, unknown> = z.lazy(() => z.object({
  name: line(100).pipe(z.string().min(1)),
  backgroundColor: loose(color),
  folders: z.array(folderSchema).max(MAX_SHARED_FOLDERS).default([]),
  sessions: z.array(sessionSchema).max(MAX_SHARED_SESSIONS).default([])
}).transform(value => compact(value)))

const payloadSchema = z.union([
  z.object({ session: sessionSchema }).transform(value => ({ kind: 'session' as const, session: value.session })),
  z.object({ folder: folderSchema }).transform(value => ({ kind: 'folder' as const, folder: value.folder }))
])

// What the sealed part holds: one entry per session, in depth-first order (see sessionsInOrder)
const secretsSchema = z.array(z.object({
  password: secret, passphrase: secret, suPassword: secret, jumpPassword: secret, jumpPassphrase: secret
}).transform(value => compact(value) as SessionSecrets)).max(MAX_SHARED_SESSIONS)

const FIELD_NAMES: Record<string, string> = {
  name: '이름', host: '호스트', port: '포트', username: '사용자', authType: '인증 방식',
  postConnectScript: '자동 실행 스크립트', jumpHost: '점프 호스트', jumpPort: '점프 호스트 포트',
  jumpUsername: '점프 호스트 사용자', jumpAuthType: '점프 호스트 인증 방식'
}

const encodeJson = (value: unknown) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)))
const decodeJson = (part: string): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(part)))

/** The share form of one saved session, without passwords */
function toShared(source: ShareSource): Partial<SharedSession> {
  const jump = source.useJumpHost === true
  const field = (key: keyof SharedSession, when = true) => (when ? source[key] : undefined)
  return compact({
    name: source.name,
    host: source.host,
    port: source.port,
    username: source.username,
    authType: field('authType'),
    backgroundColor: field('backgroundColor'),
    connectTimeout: field('connectTimeout'),
    keepaliveInterval: field('keepaliveInterval'),
    autoReconnect: field('autoReconnect'),
    postConnectScript: field('postConnectScript'),
    suRoot: field('suRoot'),
    useJumpHost: jump || undefined,
    jumpHost: field('jumpHost', jump),
    jumpPort: field('jumpPort', jump),
    jumpUsername: field('jumpUsername', jump),
    jumpAuthType: field('jumpAuthType', jump)
  }) as Partial<SharedSession>
}

/** The passwords of one session that matter for how it connects */
function secretsOf(source: ShareSource): SessionSecrets {
  const jump = source.useJumpHost === true
  const text = (key: keyof SharedSession, when = true) => (when && typeof source[key] === 'string' ? source[key] as string : undefined)
  return compact({
    password: text('password'),
    passphrase: text('passphrase'),
    suPassword: text('suPassword', source.suRoot === true),
    jumpPassword: text('jumpPassword', jump),
    jumpPassphrase: text('jumpPassphrase', jump)
  })
}

const hasAny = (entries: SessionSecrets[]) => entries.some(entry => Object.keys(entry).length > 0)
const oneLine = (text: string) => text.replace(CONTROL_RUN, ' ')
const secretNote = (sealed: boolean) => (sealed ? '비밀번호 암호화됨 · 공유 암호 필요' : '비밀번호 없음')

/** Token line; the passwords are sealed only when a passphrase is given and there is something to seal */
async function tokenLine(payload: object, secrets: SessionSecrets[], passphrase?: string): Promise<{ line: string; sealed: boolean }> {
  const plain = encodeJson(payload)
  if (!passphrase || !hasAny(secrets)) return { line: `${SHARE_PREFIX}${plain}`, sealed: false }
  const box = await sealSecrets(secrets, passphrase, plain)
  return { line: `${SHARE_PREFIX}${plain}.${encodeJson(box)}`, sealed: true }
}

/** Text for one session */
export async function buildShareText(source: ShareSource, { passphrase }: ShareOptions = {}): Promise<string> {
  const { line: token, sealed } = await tokenLine({ session: toShared(source) }, [secretsOf(source)], passphrase)
  const label = oneLine(source.name || `${source.username}@${source.host}`)
  const summary = `[ezShell 세션] ${label} · ${oneLine(`${source.username}@${source.host}:${source.port}`)} (${secretNote(sealed)})`
  return `${summary}\n${token}`
}

/** The sender's folder is larger than a receiver may import */
export class ShareTooLargeError extends Error {
  constructor() {
    super(`폴더는 ${MAX_FOLDER_DEPTH}단계, 폴더 ${MAX_SHARED_FOLDERS}개, 세션 ${MAX_SHARED_SESSIONS}개까지 복사할 수 있습니다.`)
    this.name = 'ShareTooLargeError'
  }
}

/**
 * Text for a folder with every sub-folder and session under it, or null for an unknown folder.
 * Throws ShareTooLargeError past the limits the parser enforces.
 */
export async function buildFolderShareText(
  folderId: string,
  folders: ShareFolderSource[],
  sessions: ShareSource[],
  { passphrase }: ShareOptions = {}
): Promise<string | null> {
  const root = folders.find(f => f.id === folderId)
  if (!root) return null
  const seen = new Set<string>()
  const secrets: SessionSecrets[] = []
  let folderCount = 0

  // Own sessions first, then each sub-folder: the order sessionsInOrder walks when unlocking
  const walk = (folder: ShareFolderSource, depth = 0): Partial<SharedFolder> => {
    if (depth >= MAX_FOLDER_DEPTH) throw new ShareTooLargeError()
    seen.add(folder.id)
    const own = sessions.filter(s => s.folderId === folder.id)
    own.forEach(s => secrets.push(secretsOf(s)))
    const children = folders.filter(f => f.parentId === folder.id && !seen.has(f.id))
    folderCount += children.length
    return compact({
      name: folder.name,
      backgroundColor: folder.backgroundColor,
      sessions: own.map(toShared),
      folders: children.map(child => walk(child, depth + 1))
    }) as Partial<SharedFolder>
  }

  const folder = walk(root)
  if (folderCount + 1 > MAX_SHARED_FOLDERS || secrets.length > MAX_SHARED_SESSIONS) throw new ShareTooLargeError()
  const { line: token, sealed } = await tokenLine({ folder }, secrets, passphrase)
  const summary = `[ezShell 폴더] ${oneLine(root.name)} · 하위 폴더 ${folderCount}개, 세션 ${secrets.length}개 (${secretNote(sealed)})`
  return `${summary}\n${token}`
}

/** The first v1 token in pasted text, or null */
export function findShareToken(text: string): string | null {
  const match = TOKEN_PATTERN.exec(text)
  return match && match[1] === '1' ? match[0] : null
}

/**
 * Whether the decoded JSON nests deeper than `limit` or holds more than MAX_NODES objects and arrays.
 * Cheap walk before the recursive schema runs, which would otherwise check every node first.
 */
function tooLarge(value: unknown, limit: number): boolean {
  let nodes = 0
  const walk = (node: unknown, depth: number): boolean => {
    if (node === null || typeof node !== 'object') return false
    if (depth > limit || ++nodes > MAX_NODES) return true
    const children = Array.isArray(node) ? node : Object.values(node)
    return children.some(child => walk(child, depth + 1))
  }
  return walk(value, 0)
}

function countFolders(folder: SharedFolder): number {
  return folder.folders.reduce((sum, child) => sum + 1 + countFolders(child), 0)
}

/** Every session of a tree, own sessions before sub-folders (the order the sealed list uses) */
function sessionsInOrder(folder: SharedFolder): SharedSession[] {
  return [...folder.sessions, ...folder.folders.flatMap(sessionsInOrder)]
}

function describeIssue(error: z.ZodError): string {
  const path = error.issues[0]?.path ?? []
  const key = [...path].reverse().find(part => typeof part === 'string' && part in FIELD_NAMES)
  return `${key ? FIELD_NAMES[key as string] : '세션 정보'} 값이 올바르지 않습니다.`
}

const BROKEN = '세션 텍스트가 깨졌습니다. 받은 텍스트 전체를 다시 복사해 주세요.'

/** Reads pasted text. Only known, valid fields come back, in new objects. Passwords stay sealed. */
export function parseShareText(text: string): ParseResult {
  const match = TOKEN_PATTERN.exec(text)
  if (!match) {
    return { ok: false, error: '세션 텍스트를 찾지 못했습니다. ezshell-session: 으로 시작하는 줄까지 붙여 넣어 주세요.' }
  }
  if (match[1] !== '1') {
    return { ok: false, error: '새 버전의 ezShell 에서 만든 텍스트입니다. 앱을 업데이트한 뒤 다시 시도해 주세요.' }
  }
  const [, , plainPart, sealedPart] = match
  if (plainPart.length > MAX_PLAIN_LENGTH || plainPart.length + (sealedPart?.length ?? 0) > MAX_TOKEN_LENGTH) {
    return { ok: false, error: '세션 텍스트가 너무 깁니다.' }
  }

  let raw: unknown
  let locked: LockedSecrets | undefined
  try {
    raw = decodeJson(plainPart)
    if (sealedPart) {
      const box = secretBoxSchema.safeParse(decodeJson(sealedPart))
      if (!box.success) return { ok: false, error: BROKEN }
      locked = { box: box.data, aad: plainPart }
    }
  } catch {
    return { ok: false, error: BROKEN }
  }
  // folder > folders[] > folder > ... : two levels of objects per folder level, plus sessions
  if (tooLarge(raw, MAX_FOLDER_DEPTH * 2 + 4)) {
    return { ok: false, error: `폴더 ${MAX_FOLDER_DEPTH}단계, 폴더 ${MAX_SHARED_FOLDERS}개, 세션 ${MAX_SHARED_SESSIONS}개까지 가져올 수 있습니다.` }
  }

  const result = payloadSchema.safeParse(raw)
  if (!result.success) {
    const first = result.error.issues[0]
    // A union reports both branches failing; show the field problem from the branch that matched a key
    const branch = first?.code === 'invalid_union' ? first.unionErrors.find(e => (e.issues[0]?.path.length ?? 0) > 1) : undefined
    return { ok: false, error: describeIssue(branch ?? result.error) }
  }

  const hasSecrets = locked !== undefined
  if (result.data.kind === 'session') {
    return { ok: true, kind: 'session', session: result.data.session, hasSecrets, locked }
  }
  const folder = result.data.folder
  const folderCount = countFolders(folder)
  const sessionCount = sessionsInOrder(folder).length
  if (folderCount + 1 > MAX_SHARED_FOLDERS || sessionCount > MAX_SHARED_SESSIONS) {
    return { ok: false, error: `폴더 ${MAX_SHARED_FOLDERS}개, 세션 ${MAX_SHARED_SESSIONS}개까지 가져올 수 있습니다.` }
  }
  return { ok: true, kind: 'folder', folder, hasSecrets, locked, folderCount, sessionCount }
}

/**
 * Opens the sealed passwords with the shared passphrase and puts each on its session. Returns new
 * objects without `locked`. Throws ShareUnlockError for a wrong passphrase or changed text.
 */
export async function unlockShare(parsed: ParseResult, passphrase: string): Promise<ParsedOk> {
  if (!parsed.ok) throw new ShareUnlockError()
  if (!parsed.locked) return parsed
  const opened = secretsSchema.safeParse(await openSecrets(parsed.locked.box, passphrase, parsed.locked.aad))
  const expected = parsed.kind === 'session' ? 1 : parsed.sessionCount
  if (!opened.success || opened.data.length !== expected) throw new ShareUnlockError()
  const entries = opened.data

  if (parsed.kind === 'session') {
    return { ok: true, kind: 'session', session: { ...parsed.session, ...entries[0] }, hasSecrets: true }
  }
  let index = 0
  const fill = (folder: SharedFolder): SharedFolder => {
    const filled = folder.sessions.map(s => ({ ...s, ...entries[index++] }))
    return { ...folder, sessions: filled, folders: folder.folders.map(fill) }
  }
  const { locked: _locked, ...rest } = parsed
  return { ...rest, folder: fill(parsed.folder) }
}

export interface ImportedFolder { id: string; name: string; parentId?: string; backgroundColor?: string }
export type ImportedSession = SharedSession & { id: string; folderId?: string; mcpEnabled: false; suRoot: boolean }

/** New folders and sessions (fresh ids) for a shared folder, placed under `parentId` */
export function materializeFolder(
  shared: SharedFolder,
  parentId: string | undefined,
  newId: () => string = () => crypto.randomUUID()
): { rootId: string; folders: ImportedFolder[]; sessions: ImportedSession[] } {
  const folders: ImportedFolder[] = []
  const sessions: ImportedSession[] = []
  const place = (folder: SharedFolder, parent: string | undefined): string => {
    const id = newId()
    folders.push(compact({ id, name: folder.name, parentId: parent, backgroundColor: folder.backgroundColor }))
    folder.sessions.forEach(session => {
      sessions.push({ ...session, id: newId(), folderId: id, mcpEnabled: false, suRoot: session.suRoot === true })
    })
    folder.folders.forEach(child => place(child, id))
    return id
  }
  const rootId = place(shared, parentId)
  return { rootId, folders, sessions }
}
