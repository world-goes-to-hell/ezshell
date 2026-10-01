// Renders assets/icon.svg into assets/icon.ico (16-256px) and assets/icon.png (256px),
// and writes the small-size SVG the title bar shows (src/renderer/assets/app-icon.svg).
// Usage: npm run build:icon            (optionally ICON_PREVIEW=<file.png> to also save a size sheet)
// Runs inside Electron so Chromium rasterizes the SVG at every size (crisper than downscaling one bitmap).

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { encodeBmpEntry, packIco } = require('./ico.cjs');
const { smallIconSvg } = require('./iconSvg.cjs');

const ASSETS = path.join(__dirname, '..', 'assets');
const TITLE_BAR_ICON = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'app-icon.svg');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const PNG_ONLY_FROM = 256; // Windows expects PNG for the 256px entry
const DETAIL_FROM = 32; // class="detail" elements are dropped below this size

// Runs in the page: draws the SVG at one size, returns raw RGBA and a PNG data URL
function renderInPage(svgText, size, detailFrom) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (size < detailFrom) doc.querySelectorAll('.detail').forEach(node => node.remove());
  const markup = new XMLSerializer().serializeToString(doc);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
  return img.decode().then(() => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    return {
      rgba: Array.from(ctx.getImageData(0, 0, size, size).data),
      png: canvas.toDataURL('image/png')
    };
  });
}

// Runs in the page: every size at 1x and 4x on a dark and a light strip, like a taskbar
function previewInPage(pngBySize) {
  const sizes = Object.keys(pngBySize).map(Number).filter(size => size <= 64);
  const width = 40 + sizes.reduce((sum, size) => sum + size * 4 + 24, 0);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = 2 * (64 * 4 + 40);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const strips = [['#202124', 0], ['#f3f3f3', canvas.height / 2]];
  const loads = sizes.map(size => {
    const img = new Image();
    img.src = pngBySize[size];
    return img.decode().then(() => [size, img]);
  });
  return Promise.all(loads).then(images => {
    for (const [color, top] of strips) {
      ctx.fillStyle = color;
      ctx.fillRect(0, top, width, canvas.height / 2);
      let x = 20;
      for (const [size, img] of images) {
        ctx.drawImage(img, x, top + 20);
        ctx.drawImage(img, x, top + 20 + size + 8, size * 4, size * 4);
        x += size * 4 + 24;
      }
    }
    return canvas.toDataURL('image/png');
  });
}

const dataUrlToBuffer = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');

async function main() {
  const svgText = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');

  const pngBySize = {};
  const images = [];
  for (const size of SIZES) {
    const call = `(${renderInPage.toString()})(${JSON.stringify(svgText)}, ${size}, ${DETAIL_FROM})`;
    const { rgba, png } = await win.webContents.executeJavaScript(call);
    pngBySize[size] = png;
    const data = size >= PNG_ONLY_FROM ? dataUrlToBuffer(png) : encodeBmpEntry(size, Uint8Array.from(rgba));
    images.push({ size, data });
  }

  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), packIco(images));
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), dataUrlToBuffer(pngBySize[256]));
  fs.writeFileSync(TITLE_BAR_ICON, smallIconSvg(svgText));

  if (process.env.ICON_PREVIEW) {
    const sheet = await win.webContents.executeJavaScript(`(${previewInPage.toString()})(${JSON.stringify(pngBySize)})`);
    fs.writeFileSync(process.env.ICON_PREVIEW, dataUrlToBuffer(sheet));
  }
  console.log(`icon.ico (${SIZES.join(', ')}) and icon.png written to ${ASSETS}; title bar icon: ${TITLE_BAR_ICON}`);
}

app.disableHardwareAcceleration();
app.whenReady()
  .then(main)
  .catch((error) => {
    console.error('Icon build failed:', error);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
