const CAPTURE_TIMEOUT_MS = 700;
const BACKDROP_WIDTH = 480;

async function monitorBackdrop(desktopCapturer, display) {
  const height = Math.max(1, Math.round(BACKDROP_WIDTH * display.bounds.height / display.bounds.width));
  let timer;
  try {
    const sources = await Promise.race([
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: BACKDROP_WIDTH, height } }),
      new Promise(resolve => { timer = setTimeout(resolve, CAPTURE_TIMEOUT_MS, []); })
    ]);
    const image = sources.find(source => source.display_id === String(display.id))?.thumbnail;
    return image && !image.isEmpty() ? Uint8Array.from(image.toJPEG(76)) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Tab Tab from another program aims at the monitor of that program for a moment (the window asks for
// the overview right after): the window moves there for the overview and goes back when it closes.
const AIM_MS = 3000;

/** The window's size on another monitor, in the middle of its work area (smaller if it does not fit) */
function placeOn(display, bounds) {
  const area = display.workArea ?? display.bounds;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width, height
  };
}

/** Temporarily make the main renderer fill its monitor so the same terminal views stay interactive. */
function registerWorkOverviewIpc({ ipcMain, desktopCapturer, getDisplay, getWindow, isLocked }) {
  let overview = null;
  let aim = null;
  const takeAim = () => {
    const current = aim && Date.now() - aim.at <= AIM_MS ? aim.display : null;
    aim = null;
    return current;
  };

  function putBack(current) {
    const { win, restore } = current;
    if (!restore || restore.done || win.isDestroyed()) return;
    restore.done = true;
    win.setBounds(restore.bounds);
    if (restore.maximized) win.maximize();
  }
  const belongsToWindow = (event, win) => win && !win.isDestroyed() && event.sender === win.webContents
    && event.senderFrame === win.webContents.mainFrame;

  function close(current) {
    if (overview !== current) return;
    overview = null;
    current.unsubscribe();
    if (current.win.isDestroyed()) return;
    if (current.changedFullscreen) {
      // Leaving fullscreen puts the window where it was just before (on the aimed monitor): then back home
      if (current.restore) {
        current.win.once('leave-full-screen', () => putBack(current));
        setTimeout(() => putBack(current), 600);
      }
      current.win.setFullScreen(false);
    } else putBack(current);
  }

  ipcMain.handle('work-overview-show', async event => {
    const win = getWindow();
    if (!belongsToWindow(event, win) || isLocked() || overview) return null;
    const current = { win, changedFullscreen: false, unsubscribe: () => {} };
    const onClose = () => close(current);
    const onNavigation = details => { if (details.isMainFrame && !details.isSameDocument) onClose(); };
    overview = current;
    win.on('close', onClose);
    win.webContents.on('render-process-gone', onClose);
    win.webContents.on('did-start-navigation', onNavigation);
    current.unsubscribe = () => {
      win.removeListener('close', onClose);
      if (win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.removeListener('render-process-gone', onClose);
        win.webContents.removeListener('did-start-navigation', onNavigation);
      }
    };

    const own = getDisplay(win.getBounds());
    const aimed = takeAim();
    const display = aimed && aimed.id !== own.id && !win.isFullScreen() ? aimed : own;
    const backdrop = await monitorBackdrop(desktopCapturer, display);
    if (overview !== current) return null;
    if (isLocked() || win.isDestroyed()) {
      close(current);
      return null;
    }
    if (!win.isFullScreen()) {
      try {
        if (display !== own) {
          const maximized = win.isMaximized();
          current.restore = { bounds: maximized ? win.getNormalBounds() : win.getBounds(), maximized, done: false };
          if (maximized) win.unmaximize();
          win.setBounds(placeOn(display, win.getBounds()));
        }
        win.setFullScreen(true);
        current.changedFullscreen = true;
      } catch {
        // The existing window can still show the overview
        if (!current.changedFullscreen) putBack(current);
      }
    }
    return { backdrop };
  });

  ipcMain.on('work-overview-hide', event => {
    if (overview && belongsToWindow(event, overview.win)) close(overview);
  });

  return {
    /** The monitor Tab Tab was pressed on, for the overview the window asks for next */
    aimAt(display) { aim = display ? { display, at: Date.now() } : null; }
  };
}

module.exports = { registerWorkOverviewIpc, placeOn };
