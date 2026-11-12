// Where the main window was (position, size, maximized), kept in userData/window-state.json so the
// app opens where it was closed, also after an update restarts it.

const fs = require('fs');

const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;
/** How much of the window must be on a screen for the saved place to be used */
const MIN_VISIBLE_WIDTH = 200;
const MIN_VISIBLE_HEIGHT = 100;

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * The saved place if it can still be seen on one of the screens, otherwise null (a monitor may have
 * been unplugged or its resolution changed since).
 * @param {unknown} saved
 * @param {Array<{ x: number, y: number, width: number, height: number }>} workAreas
 */
function usableState(saved, workAreas) {
  if (!saved || typeof saved !== 'object') return null;
  const { x, y, width, height } = saved;
  if (![x, y, width, height].every(isNumber)) return null;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return null;
  const isVisible = workAreas.some((area) => {
    const overlapWidth = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
    // The title bar is at the top: it has to be on the screen to move the window
    const isTopInside = y >= area.y - 10 && y < area.y + area.height - MIN_VISIBLE_HEIGHT;
    return overlapWidth >= MIN_VISIBLE_WIDTH && isTopInside;
  });
  if (!isVisible) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), isMaximized: saved.isMaximized === true };
}

function readState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeState(filePath, state) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(state), 'utf-8');
  } catch {
    // Only a convenience: the window opens at the default place next time
  }
}

/**
 * Saves the window's place when it is moved or resized (after it settles) and when it closes.
 * A maximized window keeps the size it had before, so un-maximizing after a restart works.
 */
function trackWindow(win, filePath) {
  let timer = null;
  const save = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    writeState(filePath, { ...win.getNormalBounds(), isMaximized: win.isMaximized() });
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

module.exports = { usableState, readState, writeState, trackWindow };
