// Glass surface style: the desktop shown, blurred, behind the main window (Windows acrylic).
//
// The window material has to be given when the window is created. Measured with Electron 28.3.3 on
// Windows 11: `backgroundMaterial: 'acrylic'` in the BrowserWindow options draws acrylic (frameless
// windows too), while `setBackgroundMaterial('acrylic')` on a running window draws nothing. So the
// choice made in settings is kept in userData/appearance.json and read here at the next start.

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'appearance.json';
// Windows 11 22H2: the first build with window background materials
const MIN_ACRYLIC_BUILD = 22621;
const DEFAULTS = Object.freeze({ surface: 'flat', scheme: 'dark' });

function normalize(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    surface: value.surface === 'glass' ? 'glass' : 'flat',
    scheme: value.scheme === 'light' ? 'light' : 'dark'
  };
}

/** What settings last asked for; defaults when the file is missing or unreadable */
function readAppearance(userDataDir) {
  try {
    return normalize(JSON.parse(fs.readFileSync(path.join(userDataDir, FILE_NAME), 'utf8')));
  } catch {
    return { ...DEFAULTS };
  }
}

/** Keeps the choice for the next start. Only the two known fields are written, whatever was sent. */
function writeAppearance(userDataDir, raw) {
  const value = normalize(raw);
  fs.writeFileSync(path.join(userDataDir, FILE_NAME), JSON.stringify(value));
  return value;
}

function supportsAcrylic(platform, release) {
  if (platform !== 'win32') return false;
  const build = Number(String(release).split('.')[2]);
  return Number.isInteger(build) && build >= MIN_ACRYLIC_BUILD;
}

/**
 * Extra BrowserWindow options for the main window: none unless glass was chosen and this Windows can
 * draw acrylic. The transparent background color is what lets the material show where the page
 * paints nothing.
 */
function backdropOptions(appearance, platform, release) {
  if (normalize(appearance).surface !== 'glass' || !supportsAcrylic(platform, release)) return {};
  // maximizable: false keeps the user from maximizing (title bar double-click, snapping to the top
  // edge, Win+Up). A maximized window loses the material for good; see createFillToggle.
  return { backgroundMaterial: 'acrylic', backgroundColor: '#00000000', maximizable: false };
}

const sameBounds = (a, b) => Boolean(a && b) && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * "Maximize" for a window with acrylic. Measured with Electron 28.3.3: once such a window is maximized
 * the material stops being drawn (black instead), stays gone after un-maximizing, and setting it again
 * does not bring it back. Resizing the window to the screen's work area keeps it. So the maximize
 * button fills the work area instead, and remembers the place to go back to.
 *
 * @param {{ getBounds: () => object, setBounds: (bounds: object) => void }} win
 * @param {() => { x: number, y: number, width: number, height: number }} workAreaOf the work area of the screen the window is on
 */
function createFillToggle(win, workAreaOf) {
  let normal = null;
  let filled = null;
  // Filled only while the window is still exactly where fill() put it: after the user drags or
  // resizes it, the next press fills again
  const isFilled = () => sameBounds(filled, win.getBounds());
  const fill = (normalBounds) => {
    normal = normalBounds || win.getBounds();
    win.setBounds({ ...workAreaOf() });
    // What the window actually got (the system may round or limit the size)
    filled = win.getBounds();
  };
  const restore = () => {
    if (normal) win.setBounds(normal);
    filled = null;
  };
  return {
    isFilled,
    fill,
    toggle: () => (isFilled() ? restore() : fill()),
    /** The size to save as the un-maximized place */
    normalBounds: () => (isFilled() && normal ? normal : win.getBounds())
  };
}

module.exports = { readAppearance, writeAppearance, supportsAcrylic, backdropOptions, createFillToggle, FILE_NAME };
