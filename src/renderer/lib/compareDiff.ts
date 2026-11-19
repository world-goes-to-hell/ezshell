// How the side-by-side comparison (@codemirror/merge) diffs the two texts.
//
// No `scanLimit`: with one (it was 500), the library stops matching once both texts are longer than
// about 16,000 characters and marks everything from the first difference to the end as changed: one
// line added at the top of a 25 KB file showed the whole rest of the file as changed. The time limit
// alone keeps a huge or very different pair of files from freezing the window (past it the library
// falls back to a rougher match).
export const COMPARE_DIFF_TIMEOUT_MS = 500

export const COMPARE_DIFF_CONFIG = { timeout: COMPARE_DIFF_TIMEOUT_MS } as const
