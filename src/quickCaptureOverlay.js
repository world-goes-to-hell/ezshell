// The overlay receives only the selected display's frozen image. It has no preload or Electron API.
// Marks on the chosen region (arrow, box, pen, text, badge, mosaic) come from quickCaptureEditor.js as source text.
const { EDITOR_SCRIPT } = require('./quickCaptureEditor.js')

// Provider logos and status icons for the quick work agent list (react-icons SiClaude, RiOpenaiLine,
// RiPlanetLine and the sidebar chip status icons), as 24x24 path data: the page has no React.
const AGENT_ICON_PATHS = {
  "claude": "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  "codex": "M11 4C11.6487 4 12.2498 4.20569 12.7411 4.55646C11.4486 5.22914 10.2602 6.07623 8.99996 6.80385L9.99996 8.5359C11.575 7.62654 13.0517 6.48541 14.7608 5.83037C16.1134 5.31198 17.681 5.83976 18.4282 7.13398C18.7526 7.69582 18.8749 8.31917 18.8168 8.92006C17.588 8.13708 16.2602 7.53146 15 6.80385L14 8.5359C15.575 9.44525 17.3016 10.1536 18.7234 11.3061C19.8487 12.2183 20.1754 13.8398 19.4282 15.134C19.1037 15.696 18.6249 16.1137 18.0752 16.3638C18.1385 14.9081 18 13.4553 18 12H16C16 13.8184 16.2498 15.6685 15.9626 17.4758C15.7353 18.9063 14.4944 20 13 20C12.351 20 11.7498 19.7942 11.2584 19.4432C12.5508 18.7701 13.7396 17.9238 15 17.1962L14 15.4641C12.4252 16.3733 10.9478 17.5147 9.23912 18.1696C7.88657 18.688 6.31898 18.1602 5.57176 16.866C5.24729 16.304 5.12493 15.6805 5.18316 15.0794C6.41224 15.8621 7.73964 16.4685 8.99997 17.1962L9.99997 15.4641C8.42517 14.5549 6.69801 13.8462 5.27649 12.6939C4.15128 11.7817 3.82455 10.1602 4.57176 8.86602C4.89624 8.30402 5.37506 7.88628 5.9247 7.63618C5.86145 9.09192 5.99997 10.5447 5.99997 12H7.99997C7.99997 10.1816 7.75013 8.33148 8.03733 6.52422C8.26467 5.09369 9.50554 4 11 4ZM14.7925 3.74171C13.8765 2.67659 12.5176 2 11 2C8.7782 2 6.89621 3.44833 6.24435 5.45243C4.86393 5.71314 3.59851 6.55175 2.83971 7.86602C1.72883 9.79013 2.04213 12.1442 3.4518 13.7107C2.98737 15.0366 3.08092 16.5518 3.83971 17.866C4.95059 19.7901 7.14589 20.6958 9.20742 20.2583C10.1234 21.3234 11.4824 22 13 22C15.2217 22 17.1037 20.5517 17.7556 18.5476C19.136 18.2869 20.4014 17.4482 21.1602 16.134C22.2711 14.2099 21.9578 11.8559 20.5481 10.2893C21.0126 8.96345 20.919 7.44825 20.1602 6.13398C19.0493 4.20987 16.854 3.30419 14.7925 3.74171Z",
  "antigravity": "M3.91762 8.03672C3.32984 9.2334 3 10.5794 3 12C3 16.9705 7.02944 21 12 21C13.4216 21 14.7684 20.6697 15.9657 20.0812C16.8385 20.4545 17.6848 20.6993 18.4564 20.7622C19.3582 20.8357 20.3 20.6666 20.9818 19.9848C21.7339 19.2327 21.8625 18.169 21.7279 17.1728C21.6052 16.2639 21.2481 15.2539 20.726 14.2116C20.9051 13.5031 21 12.762 21 12C21 7.02942 16.9706 2.99998 12 2.99998C11.2389 2.99998 10.4987 3.09467 9.79103 3.27331C8.7474 2.74993 7.73605 2.39184 6.8261 2.26846C5.82897 2.13327 4.76406 2.26141 4.01121 3.01425C3.3287 3.69676 3.16001 4.63968 3.2341 5.54245C3.29752 6.31512 3.54313 7.16259 3.91762 8.03672ZM5.3224 5.96587C5.2734 5.75333 5.24204 5.55727 5.2274 5.37885C5.17928 4.79255 5.31727 4.53661 5.42543 4.42846C5.54452 4.30937 5.84797 4.15415 6.55739 4.25033C6.75482 4.2771 6.96951 4.32201 7.2 4.38559C6.50364 4.82539 5.87203 5.35796 5.3224 5.96587ZM19.6124 16.8031C19.6751 17.0317 19.7195 17.2446 19.7459 17.4405C19.8416 18.1487 19.6865 18.4516 19.5676 18.5706C19.4595 18.6786 19.204 18.8165 18.6189 18.7688C18.4419 18.7543 18.2475 18.7234 18.0368 18.6751C18.6427 18.1269 19.1736 17.4972 19.6124 16.8031ZM15.8812 17.8265C14.2046 16.9483 12.2571 15.5027 10.3752 13.6209C8.4954 11.7411 7.05092 9.79573 6.17241 8.1204C7.06357 6.78477 8.40124 5.77324 9.96933 5.29879C10.6108 5.10469 11.2923 4.99998 12 4.99998C15.866 4.99998 19 8.13399 19 12C19 12.7084 18.8951 13.3905 18.7006 14.0326C18.2261 15.5992 17.2155 16.9357 15.8812 17.8265ZM13.6052 18.8153C13.0901 18.9361 12.5528 19 12 19C8.13401 19 5 15.866 5 12C5 11.4478 5.06377 10.911 5.18429 10.3964C6.14883 11.9131 7.43475 13.5089 8.96096 15.0351C10.489 16.5631 12.0868 17.8503 13.6052 18.8153Z",
  "idle": "M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM12 15C10.3431 15 9 13.6569 9 12C9 10.3431 10.3431 9 12 9C13.6569 9 15 10.3431 15 12C15 13.6569 13.6569 15 12 15Z",
  "working": "M12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22ZM12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM10.6219 8.41459L15.5008 11.6672C15.6846 11.7897 15.7343 12.0381 15.6117 12.2219C15.5824 12.2658 15.5447 12.3035 15.5008 12.3328L10.6219 15.5854C10.4381 15.708 10.1897 15.6583 10.0672 15.4745C10.0234 15.4088 10 15.3316 10 15.2526V8.74741C10 8.52649 10.1791 8.34741 10.4 8.34741C10.479 8.34741 10.5562 8.37078 10.6219 8.41459Z",
  "blocked": "M10 3H14C18.4183 3 22 6.58172 22 11C22 15.4183 18.4183 19 14 19V22.5C9 20.5 2 17.5 2 11C2 6.58172 5.58172 3 10 3ZM12 17H14C17.3137 17 20 14.3137 20 11C20 7.68629 17.3137 5 14 5H10C6.68629 5 4 7.68629 4 11C4 14.61 6.46208 16.9656 12 19.4798V17Z",
  "starting": "M6 4H4V2H20V4H18V6C18 7.61543 17.1838 8.91468 16.1561 9.97667C15.4532 10.703 14.598 11.372 13.7309 12C14.598 12.628 15.4532 13.297 16.1561 14.0233C17.1838 15.0853 18 16.3846 18 18V20H20V22H4V20H6V18C6 16.3846 6.81616 15.0853 7.8439 14.0233C8.54682 13.297 9.40202 12.628 10.2691 12C9.40202 11.372 8.54682 10.703 7.8439 9.97667C6.81616 8.91468 6 7.61543 6 6V4ZM8 4V6C8 6.88457 8.43384 7.71032 9.2811 8.58583C10.008 9.33699 10.9548 10.0398 12 10.7781C13.0452 10.0398 13.992 9.33699 14.7189 8.58583C15.5662 7.71032 16 6.88457 16 6V4H8ZM12 13.2219C10.9548 13.9602 10.008 14.663 9.2811 15.4142C8.43384 16.2897 8 17.1154 8 18V20H16V18C16 17.1154 15.5662 16.2897 14.7189 15.4142C13.992 14.663 13.0452 13.9602 12 13.2219Z"
}

const colorFields = {
  background: 'background', surface: 'surface', border: 'border', text: 'text', muted: 'muted',
  accent: 'accent', onAccent: 'on-accent', focus: 'focus', danger: 'danger'
}

function isPrintableAscii(value, limit) {
  return typeof value === 'string' && value.length <= limit && !/[^\x20-\x7e]/.test(value)
}

const trimCssSpace = value => value.replace(/^[ \t]+|[ \t]+$/g, '')

function channelInRange(channel, maximum) {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(channel)) return false
  return channel.endsWith('%') ? Number(channel.slice(0, -1)) <= 100 : Number(channel) <= maximum
}

function captureColor(value) {
  if (!isPrintableAscii(value, 64)) return undefined
  const color = trimCssSpace(value)
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return color
  const rgb = /^rgba?\(([^()]*)\)$/i.exec(color)
  if (!rgb) return undefined
  const components = trimCssSpace(rgb[1])
  let channels, alpha
  if (components.includes(',')) {
    const parts = components.split(',').map(trimCssSpace)
    if (parts.length !== 3 && parts.length !== 4) return undefined
    channels = parts.slice(0, 3)
    if (channels.some(part => part.endsWith('%') !== channels[0].endsWith('%'))) return undefined
    alpha = parts[3]
  } else {
    const parts = components.split('/')
    if (parts.length > 2) return undefined
    channels = trimCssSpace(parts[0]).split(/[ \t]+/)
    alpha = parts.length === 2 ? trimCssSpace(parts[1]) : undefined
  }
  if (channels.length !== 3 || !channels.every(channel => channelInRange(channel, 255))) return undefined
  if (alpha !== undefined && !channelInRange(alpha, 1)) return undefined
  return color
}

function captureRadius(value) {
  return isPrintableAscii(value, 12) && /^(?:0|\d+(?:\.\d+)?px)$/.test(value)
    && parseFloat(value) <= 32 ? value : undefined
}

function captureFont(value) {
  if (!isPrintableAscii(value, 160)) return undefined
  const names = value.split(',').map(trimCssSpace)
  const fontName = /^(?:[a-z0-9 -]+|'[a-z0-9 -]+'|"[a-z0-9 -]+")$/i
  return names.length <= 8 && names.every(name => fontName.test(name)) ? names.join(', ') : undefined
}

/** The renderer supplies values only. CSS names and syntax are owned here in main. */
function captureThemeTokens(theme) {
  if (!theme || typeof theme !== 'object' || Array.isArray(theme)) return {}
  const tokens = Object.entries(colorFields).map(([key, name]) => [name, captureColor(theme[key])])
  tokens.push(
    ['radius', captureRadius(theme.radius)],
    ['panel-radius', captureRadius(theme.panelRadius)],
    ['font', captureFont(theme.font)],
    ['scheme', theme.scheme === 'light' || theme.scheme === 'dark' ? theme.scheme : undefined]
  )
  return Object.fromEntries(tokens.filter(([, value]) => value !== undefined))
}

function captureThemeCss(theme) {
  const declarations = Object.entries(captureThemeTokens(theme)).map(([name, value]) => '--capture-' + name + ':' + value + ';')
  return declarations.length ? ':root{' + declarations.join('') + '}' : ''
}

const page = `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>ezShell 영역 캡처</title>
<style>
  :root {
    --capture-background: #131820;
    --capture-surface: #19212e;
    --capture-border: #627289;
    --capture-text: #ffffff;
    --capture-muted: #a6b4c8;
    --capture-accent: #3267ce;
    --capture-on-accent: #ffffff;
    --capture-focus: #83acff;
    --capture-danger: #ffb5ae;
    --capture-font: 'Segoe UI', 'Malgun Gothic', sans-serif;
    --capture-radius: 6px;
    --capture-panel-radius: 12px;
    --capture-scheme: dark;
    color-scheme: var(--capture-scheme);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
  body { background: var(--capture-background); font: 13px var(--capture-font); color: var(--capture-text); }
  body:not([data-review]) { cursor: crosshair; user-select: none; touch-action: none; }
  img { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  body:not([data-selecting])::after { content: ''; position: absolute; inset: 0; background: #10151c59; pointer-events: none; }
  #selection { position: absolute; outline: 1px solid #fff; box-shadow: 0 0 0 9999px #10151c73; pointer-events: none; }
  #hint { position: absolute; z-index: 1; top: 20px; left: 50%; transform: translateX(-50%); white-space: nowrap;
    padding: 8px 12px; border: 1px solid var(--capture-border); border-radius: var(--capture-radius); background: var(--capture-surface); pointer-events: none; }
  body[data-selecting] #hint { display: none; }
  #review { position: absolute; z-index: 2; width: min(532px, calc(100% - 24px)); padding: 16px;
    max-height: calc(100% - 24px); overflow: auto;
    border: 1px solid var(--capture-border); border-radius: var(--capture-panel-radius); background: var(--capture-surface);
    box-shadow: 0 10px 25px #0005, 0 2px 6px #0004; }
  #review:has(#review-comment[hidden]) { width: min(440px, calc(100% - 24px)); padding: 12px; }
  #review label { display: block; margin-bottom: 7px; font-weight: 600; }
  #review-comment { container-type: inline-size; line-height: 1.45; }
  .comment-field { display: grid; gap: 8px; margin-top: 16px; padding-top: 12px; border-top: 1px solid color-mix(in srgb, var(--capture-border) 60%, var(--capture-surface)); }
  #review .comment-field label { margin: 0; }
  .optional { color: var(--capture-muted); font-weight: 400; }
  #comment { display: block; width: 100%; height: 56px; resize: none; padding: 9px 10px; font: inherit;
    color: inherit; background: var(--capture-background); border: 1px solid var(--capture-border); border-radius: var(--capture-radius); }
  #comment::placeholder { color: var(--capture-muted); }
  .actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 9px; }
  button { min-width: 60px; padding: 5px 12px; font: inherit; color: inherit; cursor: pointer;
    background: var(--capture-background); border: 1px solid var(--capture-border); border-radius: var(--capture-radius); }
  button:hover:not(:disabled) { background: color-mix(in srgb, var(--capture-background) 92%, var(--capture-text)); }
  #review-comment button { min-width: 0; height: 40px; padding: 0 9px; }
  #review-comment button[aria-pressed="true"], #review-comment #work {
    border-color: var(--capture-accent); background: var(--capture-accent); color: var(--capture-on-accent);
  }
  #review-comment :is(button[aria-pressed="true"], #work):hover {
    box-shadow: inset 0 0 0 1px var(--capture-on-accent);
  }
  .review-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  #review-comment .review-actions button { padding: 0 12px; }
  #review-comment #cancel { margin-right: auto; }
  #review-comment #work { font-weight: 600; }
  #work-description { margin: 7px 0 0; color: var(--capture-muted); text-align: right; font-size: 12px; }
  :is(button, textarea, select):focus-visible { outline: 2px solid var(--capture-focus); outline-offset: 1px; }
  :is(button, select):disabled { opacity: .55; cursor: default; }
  #project { width: 100%; padding: 6px 8px; color: inherit; font: inherit;
    background: var(--capture-background); border: 1px solid var(--capture-border); border-radius: var(--capture-radius); }
  #project-path, .agent-path { display: block; color: var(--capture-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #project-path { margin-top: 4px; }
  #agents { display: grid; gap: 5px; max-height: 202px; overflow: auto; }
  #agents:not(:empty) { margin-top: 8px; padding: 2px; }
  .agent { display: flex; align-items: center; justify-content: space-between; gap: 10px; text-align: left; padding: 7px 9px; }
  .agent-info { min-width: 0; flex: 1; }
  .agent-head { display: flex; align-items: center; gap: 6px; }
  .agent-icon { flex: none; width: 15px; height: 15px; fill: currentColor; }
  .agent-icon[data-kind="claude"] { color: #d97757; }
  .agent-icon[data-state] { color: var(--capture-muted); }
  .agent-icon[data-state="working"] { color: var(--capture-accent); }
  .agent-icon[data-state="blocked"] { color: var(--capture-danger); }
  .agent-title { display: block; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
  .agent-send { flex: none; font-weight: 600; white-space: nowrap; }
  #status { margin: 8px 0 0; color: var(--capture-muted); }
  #status[data-error] { color: var(--capture-danger); }
  #status:empty { display: none; }
  #ink { position: absolute; z-index: 1; cursor: crosshair; touch-action: none; }
  #ink[data-ink-tool="text"] { cursor: text; }
  #ink[data-ink-tool="badge"] { cursor: copy; }
  #tools { --ink: #ff3b30; }
  .icon { display: block; flex: none; width: 17px; height: 17px; fill: none; stroke: currentColor;
    stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .tool-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
  #tools .tool-tile { display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 2px;
    padding: 2px; font-size: 11px; line-height: 13px; white-space: nowrap; }
  .tile-top { display: flex; align-items: center; gap: 6px; }
  kbd { display: inline-flex; min-width: 17px; height: 15px; justify-content: center; align-items: center; padding: 0 3px;
    border: 1px solid currentColor; border-radius: var(--capture-radius); font: 10px/1 Consolas, monospace; }
  .styles { display: flex; flex-wrap: wrap; gap: 12px 16px; margin-top: 16px; }
  .style-group { display: grid; gap: 6px; align-content: start; }
  .style-group + .style-group { padding-left: 16px; border-left: 1px solid color-mix(in srgb, var(--capture-border) 60%, var(--capture-surface)); }
  .group-label { color: var(--capture-muted); font-size: 12px; font-weight: 600; }
  .style-buttons { display: flex; flex-wrap: wrap; gap: 4px; }
  #tools .style-button { display: grid; place-items: center; width: 40px; padding: 0; }
  .swatch-dot { display: grid; place-items: center; width: 20px; height: 20px; border: 1px solid var(--capture-border);
    border-radius: 50%; background: var(--swatch); }
  .swatch-dot .icon { width: 12px; height: 12px; color: #111722; stroke-width: 2.4; visibility: hidden; }
  [aria-pressed="true"] .swatch-dot { box-shadow: 0 0 0 1px var(--capture-on-accent); }
  [aria-pressed="true"] .swatch-dot .icon { visibility: visible; }
  .stroke { width: 22px; height: var(--weight); border-radius: 12px; background: var(--ink); box-shadow: 0 0 0 1px currentColor; }
  .editing { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 16px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--capture-border) 60%, var(--capture-surface)); }
  .editing button, .review-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; }
  #tools #reselect { margin-left: auto; }
  @container (max-width: 405px) {
    .tool-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .style-group + .style-group { padding-left: 0; border-left: none; }
    #tools #reselect { margin-left: 0; }
  }
  #shots { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; padding: 4px 4px 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--capture-border) 60%, var(--capture-surface)); }
  #shots[hidden] { display: none; }
  .shot { position: relative; }
  #review-comment .shot-pick { position: relative; display: block; height: auto; padding: 3px; }
  .shot-thumb { display: block; height: 44px; width: auto; max-width: 132px; border-radius: 3px; }
  .shot-number { position: absolute; left: 6px; top: 6px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
    background: #000c; color: #fff; font: 600 11px/18px var(--capture-font); text-align: center; pointer-events: none; }
  #review-comment .shot-remove { position: absolute; top: -8px; right: -8px; display: grid; place-items: center;
    width: 22px; height: 22px; padding: 0; border-radius: 50%; font-size: 14px; line-height: 1; }
  .ink-text { position: absolute; z-index: 3; min-width: 120px; padding: 1px 4px; background: #000a;
    border: 1px dashed #ffffffaa; border-radius: 3px; outline: none; }
</style>
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="capture-arrow" viewBox="0 0 20 20"><path d="M4 16 16 4M9 4h7v7"/></symbol>
  <symbol id="capture-box" viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="1.5"/></symbol>
  <symbol id="capture-pen" viewBox="0 0 20 20"><path d="m4 13-.7 3.7L7 16l9-9a1.8 1.8 0 0 0-2.5-2.5L4 13Zm8.4-7.1 2.5 2.5"/></symbol>
  <symbol id="capture-text" viewBox="0 0 20 20"><path d="M4 6V4h12v2M10 4v12m-3 0h6"/></symbol>
  <symbol id="capture-badge" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.3"/><path d="m8.4 8 1.6-1.7v7.2"/></symbol>
  <symbol id="capture-mosaic" viewBox="0 0 20 20">
    <g fill="currentColor" stroke="none"><rect x="2" y="3" width="5" height="5" rx=".6"/><rect x="2" y="9" width="5" height="5" rx=".6" opacity=".74"/>
      <rect x="8.5" y="5" width="4" height="4" rx=".5" opacity=".83"/><rect x="8.5" y="10.5" width="4" height="4" rx=".5" opacity=".58"/>
      <rect x="14" y="3" width="2.5" height="2.5" rx=".4" opacity=".59"/><rect x="14.5" y="8" width="3" height="3" rx=".4" opacity=".72"/>
      <rect x="15.7" y="13" width="2" height="2" rx=".4" opacity=".43"/><rect x="5.7" y="15.4" width="2.4" height="2.4" rx=".4" opacity=".46"/></g>
  </symbol>
  <symbol id="capture-undo" viewBox="0 0 20 20"><path d="M7 4 3 8l4 4M3 8h9a4 4 0 0 1 0 8H9"/></symbol>
  <symbol id="capture-redo" viewBox="0 0 20 20"><path d="m13 4 4 4-4 4m4-4H8a4 4 0 0 0 0 8h3"/></symbol>
  <symbol id="capture-clear" viewBox="0 0 20 20"><path d="M4 6h12m-8 0V4h4v2M6 6l.6 10h6.8L14 6M9 9v4m2-4v4"/></symbol>
  <symbol id="capture-region" viewBox="0 0 20 20"><path d="M3 7V3h4m6 0h4v4m0 6v4h-4m-6 0H3v-4"/></symbol>
  <symbol id="capture-copy" viewBox="0 0 20 20"><rect x="7" y="7" width="9" height="10" rx="1.2"/><path d="M13 7V4H4v10h3"/></symbol>
  <symbol id="capture-send" viewBox="0 0 20 20"><path d="m3 9 14-5-4 13-3-5-7-3Zm7 3 7-8"/></symbol>
  <symbol id="capture-check" viewBox="0 0 20 20"><path d="m4 10 4 4 8-8"/></symbol>
  <symbol id="capture-more" viewBox="0 0 20 20"><path d="M3 7V3h4m6 0h4v4m0 6v4h-4m-6 0H3v-4m7-6v6m-3-3h6"/></symbol>
</svg>
<img id="snapshot" alt="" draggable="false">
<div id="hint">드래그해서 영역 선택 · Esc 취소</div>
<div id="selection" hidden></div>
<canvas id="ink" hidden></canvas>
<form id="review" aria-label="캡처 확인" hidden>
  <div id="review-comment">
    <div id="shots" role="group" aria-label="캡처 목록" hidden></div>
    <div id="tools" role="toolbar" aria-label="표시 도구">
      <div class="tool-grid">
        <button type="button" class="tool-tile" data-tool="arrow" title="화살표 (A)" aria-label="화살표" aria-keyshortcuts="A">
          <span class="tile-top"><svg class="icon" aria-hidden="true"><use href="#capture-arrow"/></svg><kbd aria-hidden="true">A</kbd></span>화살표
        </button>
        <button type="button" class="tool-tile" data-tool="box" title="사각형 (R)" aria-label="사각형" aria-keyshortcuts="R">
          <span class="tile-top"><svg class="icon" aria-hidden="true"><use href="#capture-box"/></svg><kbd aria-hidden="true">R</kbd></span>사각형
        </button>
        <button type="button" class="tool-tile" data-tool="pen" title="펜 (P)" aria-label="펜" aria-keyshortcuts="P">
          <span class="tile-top"><svg class="icon" aria-hidden="true"><use href="#capture-pen"/></svg><kbd aria-hidden="true">P</kbd></span>펜
        </button>
        <button type="button" class="tool-tile" data-tool="text" title="글자 (T)" aria-label="글자" aria-keyshortcuts="T">
          <span class="tile-top"><svg class="icon" aria-hidden="true"><use href="#capture-text"/></svg><kbd aria-hidden="true">T</kbd></span>글자
        </button>
        <button type="button" class="tool-tile" data-tool="badge" title="번호 (N): 코멘트에 같은 번호 줄이 생깁니다" aria-label="번호" aria-keyshortcuts="N">
          <span class="tile-top"><svg class="icon" aria-hidden="true"><use href="#capture-badge"/></svg><kbd aria-hidden="true">N</kbd></span>번호
        </button>
        <button type="button" class="tool-tile" data-tool="mosaic" title="모자이크 (M): 비밀번호·개인 정보 가리기" aria-label="모자이크" aria-keyshortcuts="M">
          <span class="tile-top"><svg class="icon" aria-hidden="true"><use href="#capture-mosaic"/></svg><kbd aria-hidden="true">M</kbd></span>모자이크
        </button>
      </div>
      <div class="styles">
        <div class="style-group" role="group" aria-labelledby="capture-colors">
          <span class="group-label" id="capture-colors">색</span>
          <div class="style-buttons">
            <button type="button" class="style-button" data-color="#ff3b30" style="--swatch:#ff3b30" title="빨강" aria-label="빨강"><span class="swatch-dot"><svg class="icon" aria-hidden="true"><use href="#capture-check"/></svg></span></button>
            <button type="button" class="style-button" data-color="#ffcc00" style="--swatch:#ffcc00" title="노랑" aria-label="노랑"><span class="swatch-dot"><svg class="icon" aria-hidden="true"><use href="#capture-check"/></svg></span></button>
            <button type="button" class="style-button" data-color="#34c759" style="--swatch:#34c759" title="초록" aria-label="초록"><span class="swatch-dot"><svg class="icon" aria-hidden="true"><use href="#capture-check"/></svg></span></button>
            <button type="button" class="style-button" data-color="#0a84ff" style="--swatch:#0a84ff" title="파랑" aria-label="파랑"><span class="swatch-dot"><svg class="icon" aria-hidden="true"><use href="#capture-check"/></svg></span></button>
            <button type="button" class="style-button" data-color="#ffffff" style="--swatch:#ffffff" title="흰색" aria-label="흰색"><span class="swatch-dot"><svg class="icon" aria-hidden="true"><use href="#capture-check"/></svg></span></button>
          </div>
        </div>
        <div class="style-group" role="group" aria-labelledby="capture-weights">
          <span class="group-label" id="capture-weights">굵기</span>
          <div class="style-buttons">
            <button type="button" class="style-button" data-width="2" title="가늘게" aria-label="가늘게"><span class="stroke" style="--weight:2px"></span></button>
            <button type="button" class="style-button" data-width="4" title="보통" aria-label="보통"><span class="stroke" style="--weight:4px"></span></button>
            <button type="button" class="style-button" data-width="7" title="굵게" aria-label="굵게"><span class="stroke" style="--weight:7px"></span></button>
          </div>
        </div>
      </div>
      <div class="editing" role="group" aria-label="표시 편집">
        <button type="button" id="undo" title="되돌리기 (Ctrl+Z)" aria-label="되돌리기" aria-keyshortcuts="Control+Z"><svg class="icon" aria-hidden="true"><use href="#capture-undo"/></svg>되돌리기</button>
        <button type="button" id="redo" title="다시 실행 (Ctrl+Y / Ctrl+Shift+Z)" aria-label="다시 실행" aria-keyshortcuts="Control+Y Control+Shift+Z"><svg class="icon" aria-hidden="true"><use href="#capture-redo"/></svg>다시 실행</button>
        <button type="button" id="clear-marks" title="표시를 모두 지웁니다" aria-label="모두 지우기"><svg class="icon" aria-hidden="true"><use href="#capture-clear"/></svg>모두 지우기</button>
        <button type="button" id="reselect" title="표시를 버리고 영역을 다시 고릅니다" aria-label="영역 다시"><svg class="icon" aria-hidden="true"><use href="#capture-region"/></svg>영역 다시</button>
      </div>
    </div>
    <div class="comment-field">
      <label for="comment">코멘트 <span class="optional">(선택)</span></label>
      <textarea id="comment" rows="2" placeholder="무엇이 문제이고 어떻게 바꿀지 적어 주세요"></textarea>
    </div>
    <div class="review-actions">
      <button id="cancel" type="button" aria-keyshortcuts="Escape">취소 <kbd aria-hidden="true">Esc</kbd></button>
      <button id="more" type="button" title="화면을 한 장 더 캡처합니다 (최대 8장)"><svg class="icon" aria-hidden="true"><use href="#capture-more"/></svg>추가 캡처</button>
      <button id="copy" type="submit"><svg class="icon" aria-hidden="true"><use href="#capture-copy"/></svg>복사</button>
      <button id="work" type="button" aria-describedby="work-description"><svg class="icon" aria-hidden="true"><use href="#capture-send"/></svg>바로작업</button>
    </div>
    <p id="work-description">프로젝트와 에이전트를 선택해 캡처와 코멘트를 보냅니다.</p>
  </div>
  <div id="picker" hidden>
    <label for="project">프로젝트 선택</label>
    <select id="project" aria-describedby="project-path"></select>
    <small id="project-path"></small>
    <div id="agents" role="group" aria-label="전송할 에이전트"></div>
    <div class="actions"><button id="back" type="button">뒤로</button></div>
  </div>
  <p id="status" role="status"></p>
</form>
<script>${EDITOR_SCRIPT}</script>
<script>
  const snapshot = document.querySelector('#snapshot')
  const box = document.querySelector('#selection')
  const review = document.querySelector('#review')
  const comment = document.querySelector('#comment')
  const reviewComment = document.querySelector('#review-comment')
  const picker = document.querySelector('#picker')
  const project = document.querySelector('#project')
  const projectPath = document.querySelector('#project-path')
  const agents = document.querySelector('#agents')
  const status = document.querySelector('#status')
  const back = document.querySelector('#back')
  const agentStates = { idle: '대기 중', working: '작업 중', blocked: '확인 대기', starting: '시작 중' }
  const agentIconPaths = ${JSON.stringify(AGENT_ICON_PATHS)}
  function agentIcon(name, label) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('class', 'agent-icon')
    svg.setAttribute('aria-hidden', 'true')
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    title.textContent = label
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', agentIconPaths[name])
    svg.append(title, path)
    return svg
  }
  const point = event => ({
    x: Math.max(0, Math.min(innerWidth, event.clientX)),
    y: Math.max(0, Math.min(innerHeight, event.clientY))
  })
  window.setCaptureImage = async image => {
    snapshot.src = image
    await snapshot.decode()
  }
  window.pickCaptureRegion = async (state = null) => {
    const editor = window.captureEditor
    const hint = document.querySelector('#hint')
    const strip = document.querySelector('#shots')
    const more = document.querySelector('#more')
    const reselect = document.querySelector('#reselect')
    let start
    let pointer
    // Counts drags, so a late capture-loss check does not cancel a newer drag
    let drags = 0
    // The region cut from this screen, while that capture is in the run
    let selection
    let projects = []
    let accept
    // When Esc was first pressed on several captures: a second press within 3 seconds throws them away
    let leaving = 0
    let stripKey = ''
    const nextAction = () => new Promise(resolve => { accept = resolve })
    function submit(action) {
      if (!accept) return
      const resolve = accept
      accept = undefined
      resolve(action)
    }
    function message(text, error = false) {
      status.textContent = text
      status.toggleAttribute('data-error', error)
      placeReview()
    }
    const count = () => editor.shots().length
    function refreshShots() {
      const list = editor.shots()
      const current = editor.active()
      const key = list.map(shot => shot.source).join(',') + '|' + current
      const height = Math.round(44 * devicePixelRatio)
      more.disabled = list.length >= MAX_SHOTS
      more.title = more.disabled ? '한 번에 ' + MAX_SHOTS + '장까지 캡처할 수 있습니다' : '화면을 한 장 더 캡처합니다 (최대 ' + MAX_SHOTS + '장)'
      reselect.disabled = list[current]?.source !== -1
      reselect.title = reselect.disabled ? '이 캡처는 영역을 다시 고를 수 없습니다. 지우고 새로 캡처하세요.' : '표시를 버리고 영역을 다시 고릅니다'
      if (key === stripKey) {
        // Only the marks changed: redraw the thumbnail of the capture being edited
        const thumb = strip.querySelector('[aria-pressed="true"] canvas')
        if (thumb && current >= 0) editor.drawThumbnail(current, thumb, height)
        return
      }
      stripKey = key
      strip.hidden = list.length < 2
      strip.replaceChildren(...(list.length < 2 ? [] : list.map((shot, index) => {
        const item = document.createElement('div')
        item.className = 'shot'
        const pick = document.createElement('button')
        pick.type = 'button'
        pick.className = 'shot-pick'
        pick.setAttribute('aria-pressed', String(index === current))
        pick.setAttribute('aria-label', '캡처 ' + (index + 1) + ' 편집')
        pick.title = '캡처 ' + (index + 1) + ' 편집'
        const thumb = document.createElement('canvas')
        thumb.className = 'shot-thumb'
        editor.drawThumbnail(index, thumb, height)
        const number = document.createElement('span')
        number.className = 'shot-number'
        number.textContent = String(index + 1)
        pick.append(thumb, number)
        pick.onclick = () => showShot(index)
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'shot-remove'
        remove.textContent = '×'
        remove.setAttribute('aria-label', '캡처 ' + (index + 1) + ' 지우기')
        remove.title = '이 캡처를 지웁니다'
        remove.onclick = () => removeShot(index)
        item.append(pick, remove)
        return item
      })))
      placeReview()
    }
    editor.configure({ onBadge: n => { comment.value = commentWithBadge(comment.value, n) }, onChange: refreshShots })
    // Put the selection box where capture i is shown: in place when it was cut from this screen, else at the top
    function positionBox(index) {
      const shot = editor.shots()[index]
      if (!shot) return
      if (shot.source === -1) {
        for (const [edge, value] of Object.entries(selection)) box.style[edge] = value * 100 + '%'
      } else {
        const reserved = review.hidden ? 420 : review.getBoundingClientRect().height
        const fitted = fitBox(shot, { width: innerWidth, height: innerHeight }, devicePixelRatio, reserved)
        for (const [edge, value] of Object.entries(fitted)) box.style[edge] = value + 'px'
      }
      box.hidden = false
    }
    function showShot(index) {
      positionBox(index)
      editor.select(index)
      placeReview()
    }
    function enterSelect() {
      selection = undefined
      box.hidden = true
      review.hidden = true
      delete document.body.dataset.review
      hint.textContent = count() ? '드래그해서 영역 선택 · Esc 캡처 목록으로' : '드래그해서 영역 선택 · Esc 취소'
      message('')
    }
    function enterReview(index) {
      document.body.dataset.review = ''
      review.hidden = false
      picker.hidden = true
      reviewComment.hidden = false
      showShot(index)
    }
    function removeShot(index) {
      editor.removeShot(index)
      const list = editor.shots()
      if (!list.some(shot => shot.source === -1)) selection = undefined
      if (!list.length) return enterSelect()
      showShot(Math.min(index, list.length - 1))
    }
    function renderAgents(selectedAgent) {
      const chosen = projects.find(item => item.folder === project.value)
      projectPath.textContent = projectPath.title = chosen?.folder ?? ''
      const buttons = (chosen?.agents ?? []).map(agent => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'agent'
        const provider = agent.kind === 'codex' ? 'Codex' : 'Claude Code'
        const who = [provider, agent.role, agent.id].filter(Boolean).join(' · ')
        button.setAttribute('aria-label', who + '에 전송')
        const info = document.createElement('span')
        info.className = 'agent-info'
        // The tool shows as its logo and the state as an icon: the words stay in the accessible name and tooltip
        const head = document.createElement('span')
        head.className = 'agent-head'
        const logo = agentIcon(agent.kind === 'codex' ? 'codex' : 'claude', provider)
        logo.dataset.kind = agent.kind === 'codex' ? 'codex' : 'claude'
        const title = document.createElement('span')
        title.className = 'agent-title'
        title.textContent = [agent.role, agent.id].filter(Boolean).join(' · ')
        head.append(logo, title)
        const state = agentStates[agent.status]
        if (state) {
          const mark = agentIcon(agent.status, state)
          mark.dataset.state = agent.status
          head.append(mark)
          button.setAttribute('aria-label', who + ' · ' + state + '에 전송')
        }
        const folder = document.createElement('small')
        folder.className = 'agent-path'
        folder.textContent = folder.title = agent.cwd
        info.append(head, folder)
        const send = document.createElement('span')
        send.className = 'agent-send'
        send.textContent = '전송'
        button.append(info, send)
        button.onclick = () => {
          if (!accept) return
          for (const control of [project, back, ...agents.children]) control.disabled = true
          message(who + '에 보내는 중…')
          submit({ action: 'send', agentId: agent.id, shots: editor.exportShots(true), comment: comment.value })
        }
        if (agent.id === selectedAgent) button.dataset.retry = ''
        return button
      })
      agents.replaceChildren(...buttons)
      placeReview()
    }
    window.captureNotice = text => {
      message(text, true)
      return nextAction()
    }
    window.chooseCaptureTarget = (options, error, selectedAgent) => {
      const previous = project.value
      projects = options
      const prompt = new Option('프로젝트를 선택하세요', '', true, true)
      prompt.disabled = true
      project.replaceChildren(prompt, ...projects.map(item => {
        const duplicate = projects.some(other => other !== item && other.name === item.name)
        return new Option(duplicate ? item.folder : item.name, item.folder)
      }))
      if (projects.length === 1) project.value = projects[0].folder
      else if (projects.some(item => item.folder === previous)) project.value = previous
      project.disabled = !projects.length
      back.disabled = false
      reviewComment.hidden = true
      picker.hidden = false
      renderAgents(selectedAgent)
      message(error || (projects.length ? '' : '열려 있는 에이전트가 없습니다.'), Boolean(error))
      const focus = agents.querySelector('[data-retry]') ?? (projects.length ? project : back)
      focus.focus()
      return nextAction()
    }
    function update(event) {
      const end = point(event)
      const left = Math.min(start.x, end.x)
      const top = Math.min(start.y, end.y)
      const width = Math.abs(start.x - end.x)
      const height = Math.abs(start.y - end.y)
      const region = { left: left / innerWidth, top: top / innerHeight, width: width / innerWidth, height: height / innerHeight }
      for (const [edge, value] of Object.entries(region)) box.style[edge] = value * 100 + '%'
      return region
    }
    function clear(event) {
      if (event.pointerId !== pointer) return
      start = undefined
      pointer = undefined
      box.hidden = true
      delete document.body.dataset.selecting
    }
    function placeReview() {
      if (review.hidden) return
      // The selection, viewport, and panel all use CSS pixels at every display scale.
      const bounds = box.getBoundingClientRect()
      const scrollTop = review.scrollTop
      review.style.width = ''
      review.style.maxHeight = ''
      const { width, height } = review.getBoundingClientRect()
      const gap = 12
      const viewport = { width: innerWidth - gap * 2, height: innerHeight - gap * 2 }
      const slots = [
        { side: 'below', left: gap, top: bounds.bottom + gap, width: viewport.width, height: innerHeight - bounds.bottom - gap * 2 },
        { side: 'above', left: gap, top: gap, width: viewport.width, height: bounds.top - gap * 2 },
        { side: 'right', left: bounds.right + gap, top: gap, width: innerWidth - bounds.right - gap * 2, height: viewport.height },
        { side: 'left', left: gap, top: gap, width: bounds.left - gap * 2, height: viewport.height }
      ]
      const clamp = (value, min, max) => Math.max(min, Math.min(value, max))
      let slot = slots.find(space => space.width >= width && space.height >= height)
      if (!slot) {
        // Keep a scrollable panel outside the selection even if the full panel cannot fit there.
        const area = space => Math.min(width, space.width) * Math.min(height, space.height)
        slot = slots.filter(space => space.width >= Math.min(272, width) && space.height >= Math.min(80, height))
          .reduce((best, space) => !best || area(space) > area(best) ? space : best, null)
      }
      let left = clamp(bounds.left, gap, innerWidth - width - gap)
      let top = innerHeight - height - gap
      if (slot) {
        const panelWidth = Math.min(width, slot.width)
        review.style.width = panelWidth + 'px'
        review.style.maxHeight = slot.height + 'px'
        const panelHeight = review.getBoundingClientRect().height
        left = clamp(bounds.left, slot.left, slot.left + slot.width - panelWidth)
        top = clamp(bounds.top, slot.top, slot.top + slot.height - panelHeight)
        if (slot.side === 'above') top = slot.top + slot.height - panelHeight
        else if (slot.side === 'below') top = slot.top
      }
      review.style.left = left + 'px'
      review.style.top = top + 'px'
      review.scrollTop = scrollTop
    }
    document.body.addEventListener('pointerdown', event => {
      if (event.button !== 0 || start || !review.hidden) return
      drags += 1
      start = point(event)
      pointer = event.pointerId
      document.body.setPointerCapture(pointer)
      document.body.dataset.selecting = ''
      box.hidden = false
      update(event)
    })
    document.body.addEventListener('pointermove', event => {
      if (start && event.pointerId === pointer) update(event)
    })
    document.body.addEventListener('pointerup', event => {
      if (!start || event.pointerId !== pointer) return
      const region = update(event)
      if (!region.width || !region.height) return clear(event)
      start = undefined
      pointer = undefined
      delete document.body.dataset.selecting
      selection = region
      const index = editor.addShot(region)
      if (index < 0) return enterSelect()
      enterReview(index)
      comment.focus()
    })
    document.body.addEventListener('pointercancel', clear)
    // Chromium can report the capture lost just before the pointerup of the same drag (seen in the capture e2e):
    // give that pointerup a moment before dropping the drag
    document.body.addEventListener('lostpointercapture', event => {
      const drag = drags
      setTimeout(() => { if (drag === drags) clear(event) }, 100)
    })
    window.addEventListener('resize', () => {
      const current = editor.active()
      if (!review.hidden && current >= 0) positionBox(current)
      placeReview()
    })
    review.addEventListener('submit', event => {
      event.preventDefault()
      if (review.hidden || reviewComment.hidden || !count()) return
      submit({
        action: 'copy', shots: editor.exportShots(true), comment: comment.value,
        combined: count() > 1 ? editor.exportCombined() : null
      })
    })
    more.onclick = () => {
      if (!accept || count() >= MAX_SHOTS) return
      submit({ action: 'more', shots: editor.exportShots(true), comment: comment.value })
    }
    document.querySelector('#work').onclick = () => {
      if (!count() || !accept) return
      reviewComment.hidden = true
      message('프로젝트를 불러오는 중…')
      submit({ action: 'targets' })
    }
    project.onchange = () => { message(''); renderAgents() }
    back.onclick = () => {
      picker.hidden = true
      reviewComment.hidden = false
      message('')
      comment.focus()
    }
    reselect.onclick = () => {
      const current = editor.active()
      if (editor.shots()[current]?.source !== -1) return
      editor.removeShot(current)
      enterSelect()
    }
    // Closing the window works even while main is looking up projects or waiting for a send.
    // Choosing a new region with earlier captures goes back to them instead, and several captures need a second press.
    const cancel = () => {
      const shots = count()
      if (review.hidden && shots) return enterReview(shots - 1)
      if (shots > 1 && Date.now() - leaving > 3000) {
        leaving = Date.now()
        const warning = 'Esc 를 한 번 더 누르면 캡처 ' + shots + '장을 모두 버립니다.'
        message(warning, true)
        setTimeout(() => { if (status.textContent === warning) message('') }, 3000)
        return
      }
      // Main closes the window when it is waiting on us; otherwise (a lookup or send in progress) close it here
      if (accept) submit({ action: 'close' })
      else window.close()
    }
    document.querySelector('#cancel').addEventListener('click', cancel)
    document.addEventListener('contextmenu', event => {
      if (review.contains(event.target)) return
      event.preventDefault()
      cancel()
    })
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing || event.repeat) return
      event.preventDefault()
      cancel()
    })
    const earlier = Array.isArray(state?.captures) ? state.captures : []
    if (typeof state?.comment === 'string') comment.value = state.comment
    if (earlier.length) await editor.loadShots(earlier)
    if (state?.review && count()) enterReview(count() - 1)
    else enterSelect()
    return nextAction()
  }
</script>
</html>`

// The strip shown between captures of one run (docs/plan/2026-11-24-capture-multiple-shots.md). Like the overlay
// it has no preload or Electron API: main waits on window.waitChip() for the name of the button pressed.
const chipPage = `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>ezShell 캡처 보관</title>
<style>
  :root {
    --capture-background: #131820;
    --capture-surface: #19212e;
    --capture-border: #627289;
    --capture-text: #ffffff;
    --capture-accent: #3267ce;
    --capture-on-accent: #ffffff;
    --capture-focus: #83acff;
    --capture-font: 'Segoe UI', 'Malgun Gothic', sans-serif;
    --capture-radius: 6px;
    --capture-panel-radius: 12px;
    --capture-scheme: dark;
    color-scheme: var(--capture-scheme);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
  body { display: flex; align-items: center; gap: 6px; padding: 0 7px 0 14px; user-select: none;
    font: 13px var(--capture-font); color: var(--capture-text); background: var(--capture-surface);
    border: 1px solid var(--capture-border); border-radius: var(--capture-panel-radius); }
  #count { margin-right: auto; font-weight: 600; white-space: nowrap; }
  button { height: 32px; padding: 0 11px; font: inherit; color: inherit; white-space: nowrap; cursor: pointer;
    background: var(--capture-background); border: 1px solid var(--capture-border); border-radius: var(--capture-radius); }
  button:hover { background: color-mix(in srgb, var(--capture-background) 92%, var(--capture-text)); }
  #capture { font-weight: 600; border-color: var(--capture-accent); background: var(--capture-accent); color: var(--capture-on-accent); }
  #capture:hover { box-shadow: inset 0 0 0 1px var(--capture-on-accent); }
  button:focus-visible { outline: 2px solid var(--capture-focus); outline-offset: 1px; }
</style>
<span id="count" role="status"></span>
<button id="capture" type="button" title="지금 화면을 캡처합니다">지금 캡처</button>
<button id="open" type="button" title="캡처한 것을 다시 열어 고치거나 보냅니다">모아 보기</button>
<button id="discard" type="button" title="보관한 캡처를 모두 버립니다">버리기</button>
<script>
  window.showCaptureCount = n => { document.querySelector('#count').textContent = '캡처 ' + n + '장 보관 중' }
  window.waitChip = () => new Promise(resolve => {
    for (const id of ['capture', 'open', 'discard']) document.getElementById(id).onclick = () => resolve(id)
  })
</script>
</html>`

function themedUrl(html, theme) {
  const css = captureThemeCss(theme)
  const themed = css ? html.replace('</style>', () => css + '\n</style>') : html
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(themed)
}

const captureOverlayUrl = theme => themedUrl(page, theme)
const captureChipUrl = theme => themedUrl(chipPage, theme)

const OVERLAY_URL = captureOverlayUrl()
module.exports = { OVERLAY_URL, captureOverlayUrl, captureChipUrl, captureThemeCss, captureThemeTokens, captureColor, captureFont }
