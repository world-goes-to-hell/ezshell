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

/** Temporarily make the main renderer fill its monitor so the same terminal views stay interactive. */
function registerWorkOverviewIpc({ ipcMain, desktopCapturer, getDisplay, getWindow, isLocked }) {
  let overview = null;
  const belongsToWindow = (event, win) => win && !win.isDestroyed() && event.sender === win.webContents
    && event.senderFrame === win.webContents.mainFrame;

  function close(current) {
    if (overview !== current) return;
    overview = null;
    current.unsubscribe();
    if (current.changedFullscreen && !current.win.isDestroyed()) current.win.setFullScreen(false);
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

    const display = getDisplay(win.getBounds());
    const backdrop = await monitorBackdrop(desktopCapturer, display);
    if (overview !== current) return null;
    if (isLocked() || win.isDestroyed()) {
      close(current);
      return null;
    }
    if (!win.isFullScreen()) {
      try {
        win.setFullScreen(true);
        current.changedFullscreen = true;
      } catch { /* The existing window can still show the overview. */ }
    }
    return { backdrop };
  });

  ipcMain.on('work-overview-hide', event => {
    if (overview && belongsToWindow(event, overview.win)) close(overview);
  });
}

module.exports = { registerWorkOverviewIpc };
