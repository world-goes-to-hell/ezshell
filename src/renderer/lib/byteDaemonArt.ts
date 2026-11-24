// Byte Daemon characters, drawn in code (no image files; the page CSP blocks data: images anyway).
// Each returns the inside of a 64x64 SVG. The strings are constants of this file: nothing from outside goes in.
// The characters keep their own colours; only the sheep's outline follows the theme (--border-strong).

const EYE = '#1d1830'
const blush = (x1: number, x2: number, y: number, rx = 3.2, ry = 1.9) =>
  `<ellipse cx="${x1}" cy="${y}" rx="${rx}" ry="${ry}" fill="#ff8fb1" opacity=".85"/><ellipse cx="${x2}" cy="${y}" rx="${rx}" ry="${ry}" fill="#ff8fb1" opacity=".85"/>`
const dotEyes = (x1: number, x2: number, y: number, r = 2.4, shine = true) =>
  `<circle cx="${x1}" cy="${y}" r="${r}" fill="${EYE}"/><circle cx="${x2}" cy="${y}" r="${r}" fill="${EYE}"/>` +
  (shine ? `<circle cx="${x1 + r * 0.38}" cy="${y - r * 0.4}" r="${r * 0.36}" fill="#fff"/><circle cx="${x2 + r * 0.38}" cy="${y - r * 0.4}" r="${r * 0.36}" fill="#fff"/>` : '')
const smile = (x: number, y: number, w = 3, stroke = 1.8) =>
  `<path d="M${x - w} ${y} Q${x} ${y + w * 0.9} ${x + w} ${y}" stroke="${EYE}" stroke-width="${stroke}" fill="none" stroke-linecap="round"/>`

export type DaemonFace = 'awake' | 'sleep' | 'happy' | 'dizzy'

const FACES: Record<DaemonFace, string> = {
  awake: `<ellipse cx="24.5" cy="35" rx="3.2" ry="4" fill="${EYE}"/><ellipse cx="39.5" cy="35" rx="3.2" ry="4" fill="${EYE}"/>
    <circle cx="25.7" cy="33.5" r="1.3" fill="#fff"/><circle cx="40.7" cy="33.5" r="1.3" fill="#fff"/>
    <path d="M28.8 41.5 Q32 45 35.2 41.5" stroke="${EYE}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
  sleep: `<path d="M21.5 35 Q24.5 37.6 27.5 35 M36.5 35 Q39.5 37.6 42.5 35" stroke="${EYE}" stroke-width="2" fill="none" stroke-linecap="round"/>
    <ellipse cx="32" cy="42.5" rx="1.8" ry="1.5" fill="${EYE}"/>`,
  happy: `<path d="M21.5 36.5 L24.5 33 L27.5 36.5 M36.5 36.5 L39.5 33 L42.5 36.5" stroke="${EYE}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M28.5 41 Q32 46 35.5 41 Z" fill="${EYE}"/>`,
  dizzy: `<path d="M22 32.5 L27 37.5 M27 32.5 L22 37.5 M37 32.5 L42 37.5 M42 32.5 L37 37.5" stroke="${EYE}" stroke-width="2" stroke-linecap="round"/>
    <path d="M28.5 43 Q30.2 41 32 43 Q33.8 45 35.5 43" stroke="${EYE}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`
}

const robot = (x: number, y: number, s: number, color: string, dark: string) => `<g transform="translate(${x} ${y}) scale(${s})">
  <path d="M0 -9 V-14" stroke="#8a87a0" stroke-width="1.6" stroke-linecap="round"/><circle cx="0" cy="-15.5" r="2.1" fill="#ff6b6b"/>
  <rect x="-7" y="7" width="14" height="10" rx="3.5" fill="${dark}"/>
  <rect x="-10.5" y="-9" width="21" height="17" rx="6" fill="${color}"/>
  <rect x="-7.5" y="-5.5" width="15" height="9.5" rx="3.5" fill="${EYE}"/>
  <circle cx="-3.2" cy="-0.8" r="1.7" fill="#7ef0c0"/><circle cx="3.2" cy="-0.8" r="1.7" fill="#7ef0c0"/>
  <ellipse cx="-8.2" cy="5" rx="1.8" ry="1.1" fill="#ff8fb1" opacity=".8"/><ellipse cx="8.2" cy="5" rx="1.8" ry="1.1" fill="#ff8fb1" opacity=".8"/>
</g>`

const daemon = (face: DaemonFace) => `
  <path d="M50 47 Q60 45 58 35" stroke="#6a59d9" stroke-width="3.2" fill="none" stroke-linecap="round"/>
  <path d="M58 35 L54 33 L60 30 Z" fill="#6a59d9"/>
  <ellipse cx="24" cy="55" rx="5.5" ry="3.4" fill="#6a59d9"/><ellipse cx="40" cy="55" rx="5.5" ry="3.4" fill="#6a59d9"/>
  <path d="M17 25 C12 14 15 7 21 8 C22 13 24 18 27 21 Z" fill="#ffb86b"/>
  <path d="M47 25 C52 14 49 7 43 8 C42 13 40 18 37 21 Z" fill="#ffb86b"/>
  <ellipse cx="32" cy="37" rx="21" ry="19" fill="#8f7df7"/>
  <ellipse cx="32" cy="45" rx="14" ry="9" fill="#a597fa"/>
  <ellipse cx="24" cy="26" rx="7" ry="3.6" fill="#fff" opacity=".25"/>
  ${FACES[face]}
  ${blush(17.5, 46.5, 41, 3.6, 2.2)}`

const bug = (body: string, spot: string) => `
  <path d="M27 20 Q23 9 17 10 M37 20 Q41 9 47 10" stroke="#3a2030" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  <circle cx="17" cy="10" r="2.8" fill="${body}"/><circle cx="47" cy="10" r="2.8" fill="${body}"/>
  <path d="M15 34 L7 30 M14 42 L6 44 M16 49 L9 55 M49 34 L57 30 M50 42 L58 44 M48 49 L55 55" stroke="#3a2030" stroke-width="2.5" stroke-linecap="round"/>
  <ellipse cx="32" cy="40" rx="18" ry="16" fill="${body}"/>
  <path d="M32 27 V55" stroke="${spot}" stroke-width="2"/>
  <circle cx="24" cy="39" r="3.2" fill="${spot}"/><circle cx="40" cy="39" r="3.2" fill="${spot}"/>
  <circle cx="25.5" cy="48.5" r="2.4" fill="${spot}"/><circle cx="38.5" cy="48.5" r="2.4" fill="${spot}"/>
  <ellipse cx="32" cy="23" rx="12" ry="8.5" fill="#3a2030"/>
  <circle cx="27" cy="22.5" r="4.2" fill="#fff"/><circle cx="37" cy="22.5" r="4.2" fill="#fff"/>
  <circle cx="27.8" cy="23.2" r="2.1" fill="${EYE}"/><circle cx="37.8" cy="23.2" r="2.1" fill="${EYE}"/>
  <ellipse cx="24" cy="33" rx="5" ry="2.4" fill="#fff" opacity=".3"/>`

const SHEEP_PUFFS: [number, number, number][] = [[24, 35, 9.5], [33, 28.5, 11], [44, 34, 9.5], [34, 42, 10.5], [24, 43, 8], [45, 42.5, 7.5]]

const ART = {
  bug: bug('#ff6b5a', '#c23b30'),
  bugWarn: bug('#ffc94d', '#d99a1e'),
  note: `
    <ellipse cx="11" cy="29" rx="9" ry="5.5" fill="#9fd8f5" opacity=".9" transform="rotate(-22 11 29)"/>
    <ellipse cx="53" cy="29" rx="9" ry="5.5" fill="#9fd8f5" opacity=".9" transform="rotate(22 53 29)"/>
    <path d="M17 11 H47 Q49 11 49 13 V43 L40 52 H17 Q15 52 15 50 V13 Q15 11 17 11 Z" fill="#ffd84d"/>
    <path d="M17 11 H47 Q49 11 49 13 V18 H15 V13 Q15 11 17 11 Z" fill="#ffbf1f"/>
    <path d="M49 43 L40 43 V52 Z" fill="#e0a91c"/>
    ${dotEyes(26, 38, 29, 2.5, false)}${blush(21.5, 42.5, 34, 3, 1.8)}${smile(32, 33.5, 2.5)}`,
  scroll: `
    <rect x="14" y="15" width="36" height="34" fill="#f3e2b8"/>
    <rect x="9" y="9" width="46" height="9" rx="4.5" fill="#d9b97a"/>
    <rect x="9" y="46" width="46" height="9" rx="4.5" fill="#d9b97a"/>
    <path d="M19 21.5 L23 24 L19 26.5" stroke="#3fae6a" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="25" y="25" width="7" height="2.3" rx="1.1" fill="#3fae6a"/>
    ${dotEyes(26, 38, 33, 2.3, false)}${blush(21.5, 42.5, 37.5, 2.8, 1.7)}${smile(32, 37, 2.5)}
    <rect x="19" y="42" width="15" height="2" rx="1" fill="#cdb88a"/>`,
  cat: `
    <path d="M13 22 L16 5 L29 15 Z" fill="#ffb35c"/><path d="M51 22 L48 5 L35 15 Z" fill="#ffb35c"/>
    <path d="M16.5 17 L17.8 10 L24 14.5 Z" fill="#ffc6c6"/><path d="M47.5 17 L46.2 10 L40 14.5 Z" fill="#ffc6c6"/>
    <ellipse cx="32" cy="27" rx="20" ry="15.5" fill="#ffb35c"/>
    <path d="M28 12.5 Q30 16 28 19.5 M32 11.5 V18.5 M36 12.5 Q34 16 36 19.5" stroke="#e8913a" stroke-width="2.2" fill="none" stroke-linecap="round"/>
    ${dotEyes(24.5, 39.5, 26, 2.6)}${blush(18.5, 45.5, 31, 3, 1.8)}
    <path d="M30.5 29.5 H33.5 L32 31.2 Z" fill="#e86a7a"/>
    <path d="M28.5 32.5 Q30.2 34.4 32 32.6 Q33.8 34.4 35.5 32.5" stroke="${EYE}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <circle cx="32" cy="48" r="12.5" fill="#7ad1c7"/><circle cx="32" cy="48" r="9.3" fill="#fff"/>
    <path d="M32 48 V42.2 M32 48 H36.6" stroke="${EYE}" stroke-width="2" stroke-linecap="round"/>
    <ellipse cx="20.5" cy="45.5" rx="4.2" ry="3.4" fill="#ffb35c"/><ellipse cx="43.5" cy="45.5" rx="4.2" ry="3.4" fill="#ffb35c"/>`,
  hamster: `
    <circle cx="20" cy="10.5" r="5.2" fill="#f5c99b"/><circle cx="44" cy="10.5" r="5.2" fill="#f5c99b"/>
    <circle cx="20" cy="10.5" r="2.6" fill="#ffb3b3"/><circle cx="44" cy="10.5" r="2.6" fill="#ffb3b3"/>
    <ellipse cx="32" cy="22" rx="16" ry="13" fill="#f5c99b"/>
    <ellipse cx="32" cy="27.5" rx="9.5" ry="6" fill="#fff6ea"/>
    ${dotEyes(25.5, 38.5, 19.5, 2.4)}
    <ellipse cx="32" cy="24" rx="1.8" ry="1.3" fill="#e86a7a"/>
    ${blush(20.5, 43.5, 25, 3, 1.8)}
    <rect x="10" y="31" width="44" height="25" rx="3" fill="#d9a066"/>
    <rect x="10" y="31" width="44" height="5" fill="#c48a52"/>
    <rect x="28" y="31" width="8" height="25" fill="#ecc893"/>
    <ellipse cx="23.5" cy="31.5" rx="3.8" ry="2.6" fill="#f5c99b"/><ellipse cx="40.5" cy="31.5" rx="3.8" ry="2.6" fill="#f5c99b"/>`,
  duck: `
    <rect x="5" y="49" width="54" height="9" rx="4.5" fill="#7b8499"/>
    ${[12, 24, 36, 48].map(x => `<circle cx="${x}" cy="53.5" r="2.6" fill="#c3c9d6"/>`).join('')}
    <path d="M47 33 L58 25 L55 40 Z" fill="#ffd84d"/>
    <ellipse cx="35" cy="39" rx="18" ry="11" fill="#ffd84d"/>
    <path d="M30 38 Q39 31 46 38 Q39 45 30 42 Z" fill="#ffc31f"/>
    <circle cx="24" cy="24" r="11" fill="#ffd84d"/>
    <ellipse cx="13.5" cy="27" rx="5.5" ry="3" fill="#ff9f43"/>
    ${dotEyes(21.5, 30, 22, 2.3)}${blush(18, 32, 28.5, 2.4, 1.5)}
    <ellipse cx="22" cy="17" rx="4" ry="2" fill="#fff" opacity=".35"/>`,
  octopus: `
    ${[[20, 2], [26, -1], [32, 1], [38, -1], [44, 2]].map(([x, d], i) => `<path d="M${x} 38 Q${x - 6 + i * 3} ${50 + d} ${x - 3 + i * 1.5} 56 Q${x + i} 59 ${x + 2} 55" stroke="#ff8fa3" stroke-width="5.5" fill="none" stroke-linecap="round"/>`).join('')}
    <ellipse cx="32" cy="29" rx="17" ry="15" fill="#ff8fa3"/>
    <ellipse cx="25" cy="22" rx="5" ry="2.6" fill="#fff" opacity=".3"/>
    <path d="M15 19 Q32 1 49 19 Z" fill="#2f3a56"/>
    <rect x="14" y="16.5" width="36" height="5" rx="2.5" fill="#f5f5f5"/>
    <circle cx="32" cy="12.5" r="2.6" fill="#ffd166"/>
    ${dotEyes(25.5, 38.5, 30, 2.5)}${blush(20, 44, 35, 3, 1.8)}${smile(32, 35, 2.6)}
    <rect x="3" y="31" width="9" height="9" rx="2" fill="#d9a066" transform="rotate(-14 7.5 35.5)"/>
    <rect x="52" y="35" width="9" height="9" rx="2" fill="#7ad1c7" transform="rotate(12 56.5 39.5)"/>`,
  robots: robot(17, 32, 0.78, '#b9adff', '#9a8be8') + robot(47, 32, 0.78, '#ffb38a', '#e8956a') + robot(32, 40, 1, '#7ad1c7', '#58b3a8'),
  sheep: `
    ${[23, 29, 37, 43].map(x => `<rect x="${x - 2}" y="46" width="4.2" height="10" rx="2.1" fill="#4b4a63"/>`).join('')}
    <g fill="#f4f6ff" stroke="var(--border-strong)" stroke-width="1.4">${SHEEP_PUFFS.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')}</g>
    <g fill="#f4f6ff">${SHEEP_PUFFS.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r - 0.9}"/>`).join('')}</g>
    <ellipse cx="11" cy="32" rx="4.2" ry="2.3" fill="#4b4a63" transform="rotate(-25 11 32)"/>
    <ellipse cx="17.5" cy="37" rx="7.5" ry="8.5" fill="#4b4a63"/>
    <circle cx="15" cy="35.5" r="1.7" fill="#fff"/><circle cx="20.5" cy="35.5" r="1.7" fill="#fff"/>
    <ellipse cx="17.7" cy="41" rx="2.2" ry="1.3" fill="#ff8fb1" opacity=".85"/>
    <rect x="34" y="35" width="13" height="8.5" rx="2" fill="#5d6b8a"/>
    <circle cx="37.2" cy="39.2" r="1.5" fill="#5be38a"/><rect x="40" y="38.2" width="5" height="2" rx="1" fill="#8e9bb8"/>`,
  keyboard: `
    <rect x="6" y="18" width="52" height="28" rx="6" fill="#8a87a0"/>
    ${[0, 1, 2, 3, 4].map(i => `<rect x="${11 + i * 9}" y="23" width="6.5" height="6" rx="1.6" fill="#e9e7f2"/>`).join('')}
    ${[0, 1, 2, 3].map(i => `<rect x="${15.5 + i * 9}" y="31.5" width="6.5" height="6" rx="1.6" fill="#e9e7f2"/>`).join('')}
    <rect x="19" y="40" width="26" height="3.5" rx="1.6" fill="#e9e7f2"/>`,
  server: [0, 1, 2].map(i => `<rect x="14" y="${8 + i * 16.5}" width="36" height="14" rx="3.5" fill="#5d6b8a"/>
    <circle cx="20.5" cy="${15 + i * 16.5}" r="2.4" fill="${['#5be38a', '#ffd166', '#ff6b6b'][i]}"/>
    <rect x="26" y="${13.6 + i * 16.5}" width="18" height="2.8" rx="1.4" fill="#8e9bb8"/>`).join(''),
  hammer: `<rect x="29" y="22" width="6" height="34" rx="3" fill="#c48a52"/><rect x="14" y="10" width="36" height="15" rx="4" fill="#8e9bb8"/><rect x="14" y="10" width="36" height="5" rx="2.5" fill="#b8c2d8"/>`,
  flask: `<path d="M26 8 H38 V24 L50 50 Q52 56 46 56 H18 Q12 56 14 50 L26 24 Z" fill="#dfe8ff"/><path d="M20 42 H44 L48 50 Q49 53 46 53 H18 Q15 53 16 50 Z" fill="#6fd49a"/><circle cx="28" cy="46" r="2" fill="#fff" opacity=".7"/><circle cx="36" cy="48" r="1.5" fill="#fff" opacity=".7"/><rect x="24" y="6" width="16" height="5" rx="2.5" fill="#8e9bb8"/>`,
  rocket: `<path d="M32 6 Q46 18 44 40 H20 Q18 18 32 6 Z" fill="#f4f6ff"/><circle cx="32" cy="24" r="5.5" fill="#7aa2f7"/><path d="M20 32 L12 46 L20 44 Z M44 32 L52 46 L44 44 Z" fill="#ff6b6b"/><path d="M26 40 H38 L35 52 Q32 58 29 52 Z" fill="#ffb86b"/>`
} as const

export type ArtKey = keyof typeof ART | 'daemon'

/** The inside of a 64x64 SVG for a character or an object */
export function artMarkup(name: ArtKey, face: DaemonFace = 'awake'): string {
  return name === 'daemon' ? daemon(face) : ART[name]
}

/** The 16px status bar icon: drawn for its size (shrinking the big daemon blurs the face) */
export function statusIconMarkup(asleep: boolean): string {
  const eyes = asleep
    ? `<rect x="4.5" y="9" width="2.7" height="1.15" rx=".55" fill="${EYE}"/><rect x="8.8" y="9" width="2.7" height="1.15" rx=".55" fill="${EYE}"/>`
    : `<rect x="4.9" y="7.4" width="1.9" height="2.8" rx=".95" fill="${EYE}"/><rect x="9.2" y="7.4" width="1.9" height="2.8" rx=".95" fill="${EYE}"/>
       <path d="M6.6 11.9 Q8 13.1 9.4 11.9" stroke="${EYE}" stroke-width="1" fill="none" stroke-linecap="round"/>`
  return `<path d="M2.6 6.2 L3.1 1.4 L6.4 4.4 Z M13.4 6.2 L12.9 1.4 L9.6 4.4 Z" fill="#ffb86b"/><circle cx="8" cy="9.2" r="6.2" fill="#8f7df7"/>${eyes}`
}
