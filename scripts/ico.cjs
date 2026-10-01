// Minimal .ico writer. Small sizes are stored as 32-bit BMP (DIB) entries, which every Windows
// consumer reads (NSIS installer icons included); 256px is stored as PNG, as Windows expects.

const ICONDIR_SIZE = 6;
const ICONDIRENTRY_SIZE = 16;
const BITMAPINFOHEADER_SIZE = 40;

/**
 * @param {number} size  width = height in pixels
 * @param {Uint8Array} rgba  size*size*4 bytes, top row first
 * @returns {Buffer} DIB data for one icon directory entry
 */
function encodeBmpEntry(size, rgba) {
  const pixelBytes = size * size * 4;
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const maskBytes = maskRowBytes * size;
  const out = Buffer.alloc(BITMAPINFOHEADER_SIZE + pixelBytes + maskBytes);

  out.writeUInt32LE(BITMAPINFOHEADER_SIZE, 0);
  out.writeInt32LE(size, 4);
  out.writeInt32LE(size * 2, 8); // XOR bitmap + AND mask
  out.writeUInt16LE(1, 12); // planes
  out.writeUInt16LE(32, 14); // bits per pixel
  out.writeUInt32LE(0, 16); // BI_RGB
  out.writeUInt32LE(pixelBytes + maskBytes, 20);

  // Rows bottom-up, RGBA -> BGRA
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    const dstRow = BITMAPINFOHEADER_SIZE + y * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      out[d] = rgba[s + 2];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s];
      out[d + 3] = rgba[s + 3];
    }
  }
  // AND mask stays zero: the alpha channel carries transparency
  return out;
}

/**
 * @param {{ size: number, data: Buffer }[]} images  entry data (BMP from encodeBmpEntry, or PNG bytes)
 * @returns {Buffer} the .ico file
 */
function packIco(images) {
  const header = Buffer.alloc(ICONDIR_SIZE);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = ICONDIR_SIZE + ICONDIRENTRY_SIZE * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(ICONDIRENTRY_SIZE);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette colors
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map(image => image.data)]);
}

module.exports = { encodeBmpEntry, packIco };
