// Static assets imported from renderer code resolve to their URL (Vite)
declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.svg?no-inline' {
  const src: string
  export default src
}
