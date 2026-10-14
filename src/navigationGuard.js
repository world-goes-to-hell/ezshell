const path = require('path');
const { fileURLToPath } = require('url');

// Every window shows the app's own page and nothing else. A page that got script into the renderer
// (or a link in terminal output) must not be able to send a window that has the preload API to
// another page, or open a new window.

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * @param {unknown} url
 * @param {{ rendererFile: string, devUrls?: string[] }} options devUrls is empty outside development
 * @returns {boolean}
 */
function isAllowedNavigation(url, { rendererFile, devUrls = [] }) {
  if (typeof url !== 'string' || !url) return false;
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol === 'file:') {
    // A host means a network share (file://server/share/...)
    if (target.host) return false;
    try {
      return samePath(fileURLToPath(`file://${target.pathname}`), rendererFile);
    } catch {
      return false;
    }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  return devUrls.some((devUrl) => {
    try {
      return new URL(devUrl).origin === target.origin;
    } catch {
      return false;
    }
  });
}

/**
 * @param {import('electron').WebContents} contents
 * @param {{ rendererFile: string, devUrls?: string[] }} options
 */
function guardWebContents(contents, options) {
  const stopUnlessAllowed = (event, url) => {
    if (!isAllowedNavigation(url, options)) event.preventDefault();
  };
  contents.on('will-navigate', stopUnlessAllowed);
  contents.on('will-redirect', stopUnlessAllowed);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

module.exports = { isAllowedNavigation, guardWebContents };
