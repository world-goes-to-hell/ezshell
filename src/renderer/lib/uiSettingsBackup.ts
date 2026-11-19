import { PRESET_THEMES } from '../themes/presets'
import { sanitizeStoredThemes } from './themeValidation'
import { parseSurface, clampWindowOpacity } from './appearance'
import { snapZoom } from './appZoom'
import { parseCustomBindings } from './shortcutCapture'
import { clampTreeWidth } from './dbGrid'
import { parseExportPrefs } from './dbExport'
import { parseExplorerWidth, FILE_EXPLORER_WIDTH_KEY } from './fileExplorerWidth'
import { parseQueueHeight, QUEUE_HEIGHT_STORAGE_KEY } from './transferQueueHeight'
import { parseLocalPanePrefs, LOCAL_PANE_STORAGE_KEY } from './localTerminalPane'
import { parseActivityPrefs, ACTIVITY_PREFS_KEY } from './mcpActivity'
import { THEME_STORAGE_KEY } from './themeSync'
import { parseLogViewPrefs, LOG_VIEW_PREFS_KEY } from './logViewPrefs'
import { MARKDOWN_SPLIT_KEY, readSplit } from './markdownSplit'

/**
 * 화면 설정 내보내기·가져오기 (설정 > 백업 > 화면 설정).
 *
 * Only the localStorage keys listed in UI_SETTING_ENTRIES travel, and each value is rewritten by its
 * feature's own reader before it leaves or enters this PC: a file is someone else's input, and a
 * stored value may be damaged too. Left out on purpose, because they name servers, accounts or
 * folders: connection history, statistics, recent commands, snippets, the DB tree filter / consoles /
 * default schema (their keys contain host and user), and the terminal find prefs (a folder path).
 */

export const UI_SETTINGS_FORMAT = 'ezshell-ui-settings'
export const UI_SETTINGS_VERSION = 1
/** A settings file is a few KB; custom themes can add some. Anything bigger is not one. */
export const UI_SETTINGS_MAX_BYTES = 1024 * 1024

export type UiSettingGroup = 'theme' | 'shortcuts' | 'layout' | 'view'

export const UI_SETTING_GROUP_LABELS: Record<UiSettingGroup, string> = {
  theme: '테마',
  shortcuts: '키보드 단축키',
  layout: '패널 크기·배치',
  view: '보기 옵션'
}

export interface NormalizeContext {
  /** Ids of the shortcuts this version knows (shortcutsStore) */
  shortcutIds: readonly string[]
}

export interface UiSettingEntry {
  key: string
  group: UiSettingGroup
  label: string
  /** The value as its feature would read it, written back in its stored form. null: nothing usable. */
  normalize: (raw: string, context: NormalizeContext) => string | null
}

const parseObject = (raw: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** "on" / "off" switches (their readers treat everything but "off" as on) */
const onOff = (raw: string): string | null => (raw === 'on' || raw === 'off' ? raw : null)

const number = (read: (raw: string) => number) => (raw: string): string | null =>
  raw.trim() !== '' && Number.isFinite(Number(raw)) ? String(read(raw)) : null

function normalizeThemeStore(raw: string): string | null {
  const state = parseObject(raw)?.state
  if (!state || typeof state !== 'object') return null
  const stored = state as Record<string, unknown>
  const customThemes = sanitizeStoredThemes(stored.customThemes)
  const chosen = stored.currentThemeId
  const isKnown = typeof chosen === 'string' && [...PRESET_THEMES, ...customThemes].some(theme => theme.id === chosen)
  return JSON.stringify({
    state: {
      // An unknown theme id is left out: the importing side keeps its own theme
      ...(isKnown ? { currentThemeId: chosen } : {}),
      customThemes,
      surface: parseSurface(stored.surface),
      windowOpacity: clampWindowOpacity(stored.windowOpacity)
    },
    version: 0
  })
}

/** Sidebar mode and zoom. Zen mode is a state of the moment, not a setting: it does not travel. */
function normalizeUiStore(raw: string): string | null {
  const state = parseObject(raw)?.state
  if (!state || typeof state !== 'object') return null
  const { sidebarMode, appZoom } = state as Record<string, unknown>
  const result: Record<string, unknown> = {}
  if (sidebarMode === 'compact' || sidebarMode === 'expanded') result.sidebarMode = sidebarMode
  if (typeof appZoom === 'number' && Number.isFinite(appZoom)) result.appZoom = snapZoom(appZoom)
  return Object.keys(result).length > 0 ? JSON.stringify({ state: result, version: 0 }) : null
}

function normalizeContainerPrefs(raw: string): string | null {
  const value = parseObject(raw)
  if (!value) return null
  return JSON.stringify({ showAll: value.showAll === true, autoRefresh: value.autoRefresh === true })
}

const viaParser = <T>(parse: (raw: string) => T) => (raw: string): string | null =>
  parseObject(raw) ? JSON.stringify(parse(raw)) : null

export const UI_STORE_KEY = 'ui-store'
export const SHORTCUTS_KEY = 'customShortcuts'

export const UI_SETTING_ENTRIES: readonly UiSettingEntry[] = [
  { key: THEME_STORAGE_KEY, group: 'theme', label: '테마, 사용자 지정 테마, 표면 스타일, 창 투명도', normalize: normalizeThemeStore },
  {
    key: SHORTCUTS_KEY,
    group: 'shortcuts',
    label: '바꾼 단축키',
    normalize: (raw, { shortcutIds }) => (parseObject(raw) ? JSON.stringify(parseCustomBindings(raw, shortcutIds)) : null)
  },
  { key: UI_STORE_KEY, group: 'layout', label: '사이드바 접힘, 화면 확대 비율', normalize: normalizeUiStore },
  { key: LOCAL_PANE_STORAGE_KEY, group: 'layout', label: '사이드바 로컬 터미널 목록 높이', normalize: viaParser(parseLocalPanePrefs) },
  { key: FILE_EXPLORER_WIDTH_KEY, group: 'layout', label: '파일 탐색기 너비', normalize: number(parseExplorerWidth) },
  { key: QUEUE_HEIGHT_STORAGE_KEY, group: 'layout', label: 'SFTP 전송 큐 높이', normalize: number(parseQueueHeight) },
  { key: 'dbTreeWidth', group: 'layout', label: 'DB 트리 너비', normalize: number(raw => clampTreeWidth(Number(raw))) },
  { key: ACTIVITY_PREFS_KEY, group: 'view', label: 'MCP 활동 패널 보기', normalize: viaParser(parseActivityPrefs) },
  { key: 'containerPanelPrefs', group: 'view', label: '컨테이너 패널 옵션', normalize: normalizeContainerPrefs },
  { key: 'dbExportPrefs', group: 'view', label: 'DB 결과 추출 형식', normalize: viaParser(parseExportPrefs) },
  { key: 'dbDiscoveryAuto', group: 'view', label: 'DB 자동 찾기', normalize: onOff },
  { key: 'remoteCompareSyncScroll', group: 'view', label: '백업 비교 스크롤 동기화', normalize: onOff },
  { key: LOG_VIEW_PREFS_KEY, group: 'view', label: '실시간 보기의 목록 패널·줄바꿈', normalize: viaParser(parseLogViewPrefs) },
  { key: MARKDOWN_SPLIT_KEY, group: 'layout', label: '마크다운 나란히 보기의 편집기 폭', normalize: number(raw => readSplit(raw)) },
  { key: 'terminalFileZone', group: 'view', label: '터미널 파일 영역 테두리', normalize: onOff },
  { key: 'terminalLogHighlight', group: 'view', label: '터미널 오류·경고 줄 강조', normalize: onOff }
]

export interface UiSettingsFile {
  format: typeof UI_SETTINGS_FORMAT
  version: number
  exportedAt: string
  settings: Record<string, string>
}

/** What this PC has stored, checked, ready to write to a file. `read` is localStorage.getItem. */
export function collectUiSettings(read: (key: string) => string | null, context: NormalizeContext, now: Date): UiSettingsFile {
  const settings: Record<string, string> = {}
  for (const entry of UI_SETTING_ENTRIES) {
    const raw = read(entry.key)
    const value = raw === null ? null : entry.normalize(raw, context)
    if (value !== null) settings[entry.key] = value
  }
  return { format: UI_SETTINGS_FORMAT, version: UI_SETTINGS_VERSION, exportedAt: now.toISOString(), settings }
}

export interface UiSettingsImport {
  /** Checked values to apply, in the order of UI_SETTING_ENTRIES */
  values: { entry: UiSettingEntry; value: string }[]
  /** Listed keys whose value was not usable */
  invalid: number
  /** Keys in the file that are not on the list (never applied) */
  unknown: number
}

export type UiSettingsParseResult = { ok: true; import: UiSettingsImport } | { ok: false; error: string }

/** Reads a settings file's text. Nothing in it is trusted: only listed keys, each through its reader. */
export function parseUiSettingsFile(text: string, context: NormalizeContext): UiSettingsParseResult {
  if (text.length > UI_SETTINGS_MAX_BYTES) return { ok: false, error: '파일이 너무 큽니다.' }
  const file = parseObject(text)
  if (!file || file.format !== UI_SETTINGS_FORMAT) return { ok: false, error: 'ezShell 화면 설정 파일이 아닙니다.' }
  if (typeof file.version !== 'number' || file.version > UI_SETTINGS_VERSION) {
    return { ok: false, error: '더 새로운 버전의 ezShell 에서 만든 파일입니다. 앱을 업데이트한 뒤 다시 시도해 주세요.' }
  }
  const settings = file.settings
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { ok: false, error: '설정 내용이 없습니다.' }

  const stored = settings as Record<string, unknown>
  const values: UiSettingsImport['values'] = []
  let invalid = 0
  for (const entry of UI_SETTING_ENTRIES) {
    if (!Object.prototype.hasOwnProperty.call(stored, entry.key)) continue
    const raw = stored[entry.key]
    const value = typeof raw === 'string' ? entry.normalize(raw, context) : null
    if (value === null) invalid += 1
    else values.push({ entry, value })
  }
  const listed = new Set(UI_SETTING_ENTRIES.map(entry => entry.key))
  const unknown = Object.keys(stored).filter(key => !listed.has(key)).length
  if (values.length === 0) return { ok: false, error: '가져올 수 있는 설정이 없습니다.' }
  return { ok: true, import: { values, invalid, unknown } }
}

/** Group labels of what an import holds, in display order, for the summary line */
export function groupsOf(values: UiSettingsImport['values']): string[] {
  const order: UiSettingGroup[] = ['theme', 'shortcuts', 'layout', 'view']
  return order.filter(group => values.some(item => item.entry.group === group)).map(group => UI_SETTING_GROUP_LABELS[group])
}
