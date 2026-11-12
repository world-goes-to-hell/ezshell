// Static assets imported from renderer code resolve to their URL (Vite)
declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.svg?no-inline' {
  const src: string
  export default src
}

// Vite's import.meta.glob, only the eager form used for release-notes/*.md (vite/client is not
// referenced as a whole: its own '*.svg' declaration would clash with the ones above)
interface ImportMeta {
  glob(pattern: string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>
}
