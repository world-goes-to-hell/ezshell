// The tab name of a browser tab follows the page shown in it, like a web browser's tab.

export const BROWSER_TAB_DEFAULT_TITLE = '브라우저'
const MAX_TITLE_LENGTH = 80

/** One line of plain text: no control or invisible format characters, spaces collapsed */
function cleanTitle(title: string): string {
  return title.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** The page's title, else its host (a page without a title, or before the title arrives), else the default */
export function pageTabTitle(state: { title?: string; url: string }, titleLimit = MAX_TITLE_LENGTH): string {
  const title = cleanTitle(state.title ?? '')
  if (title.length > titleLimit) return `${title.slice(0, titleLimit - 1)}…`
  return title || hostOf(state.url) || BROWSER_TAB_DEFAULT_TITLE
}

/**
 * The tab name to set, or null to leave the tab alone: unchanged, or renamed by the user (the tab no
 * longer shows what was last set automatically, so the page must not overwrite the user's name).
 */
export function nextBrowserTabTitle(current: string, lastAuto: string | undefined, next: string): string | null {
  if (current !== (lastAuto ?? BROWSER_TAB_DEFAULT_TITLE)) return null
  return next === current ? null : next
}
