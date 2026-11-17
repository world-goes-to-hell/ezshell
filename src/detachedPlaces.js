// Where each kind of detached window (SFTP, terminal, MCP activity, server file, DB) was last left,
// kept in userData/detached-window-state.json so the next window of that kind opens there. One
// place per kind: the last window moved or closed wins. Only numbers and a flag are stored.

const windowState = require('./windowState.js');

const KINDS = ['sftp', 'terminal', 'mcpActivity', 'remoteFile', 'db'];
/** A window opening where one of its kind already is moves down and right by this much */
const CASCADE_STEP = 30;
const CASCADE_LIMIT = 10;
/** Two windows count as in the same place when their corners are this close */
const SAME_PLACE = 8;

const isKind = (kind) => KINDS.includes(kind);

/**
 * The place to open a window of a kind at.
 * @param {{ saved: unknown, workAreas: Array<{x:number,y:number,width:number,height:number}>,
 *   others: Array<{x:number,y:number}>, fallback: {width:number,height:number},
 *   min: {width:number,height:number} }} input `others`: where the open windows of the kind are
 * @returns {{ width: number, height: number, x?: number, y?: number, isMaximized: boolean }}
 *   without x/y the system picks the position (nothing saved, or the saved place is off screen)
 */
function placeFor({ saved, workAreas, others = [], fallback, min }) {
  const usable = windowState.usableState(saved, workAreas, min);
  if (!usable) return { width: fallback.width, height: fallback.height, isMaximized: false };

  const taken = (x, y) => others.some(o => Math.abs(o.x - x) < SAME_PLACE && Math.abs(o.y - y) < SAME_PLACE);
  let { x, y } = usable;
  for (let step = 0; step < CASCADE_LIMIT && taken(x, y); step++) {
    x += CASCADE_STEP;
    y += CASCADE_STEP;
  }
  // A stepped place that left the screen is not used: the saved one is known to be visible
  const stepped = windowState.usableState({ ...usable, x, y }, workAreas, min);
  return stepped || usable;
}

function readPlaces(filePath) {
  const all = windowState.readState(filePath);
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
}

/** Writes one kind's place, keeping the others */
function writePlace(filePath, kind, place) {
  if (!isKind(kind)) return;
  const kept = {};
  const all = readPlaces(filePath);
  for (const known of KINDS) if (all[known] && typeof all[known] === 'object') kept[known] = all[known];
  windowState.writeState(filePath, { ...kept, [kind]: place });
}

/**
 * Saves the window's place under its kind when it is moved or resized (after it settles) and when
 * it closes. `place` replaces the window's own answers where "maximized" is not the native state
 * (a window with acrylic fills the work area instead: src/nativeBackdrop.js).
 */
function trackWindow(win, filePath, kind, place) {
  let timer = null;
  const normalBounds = place ? place.normalBounds : () => win.getNormalBounds();
  const isMaximized = place ? place.isMaximized : () => win.isMaximized();
  const save = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const { x, y, width, height } = normalBounds();
    writePlace(filePath, kind, { x, y, width, height, isMaximized: isMaximized() });
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) win.on(event, later);
  win.on('close', () => {
    clearTimeout(timer);
    save();
  });
}

module.exports = { KINDS, placeFor, readPlaces, writePlace, trackWindow };
