// Packs PNG buffers into an .icns container (Apple Icon Image format), on any OS.
// Mirrors ico.cjs: no macOS tooling (iconutil) needed, so the .icns can be built and
// committed from Windows and electron-builder uses it directly on the macOS CI runner.
//
// Layout: 'icns' magic + uint32 BE total length, then one block per icon:
//   4-byte OSType + uint32 BE block length (including the 8-byte header) + PNG bytes.
// The OSTypes below all accept PNG data on modern macOS (10.7+).

// size (px) -> OSType. ic11/ic12 are the 16pt@2x / 32pt@2x retina slots.
const ICNS_TYPE_BY_SIZE = {
  32: 'ic11',
  64: 'ic12',
  128: 'ic07',
  256: 'ic08',
  512: 'ic09',
  1024: 'ic10'
};

function packIcns(entries) {
  // entries: [{ type: 'ic08', data: Buffer (PNG bytes) }]
  const blocks = entries.map(({ type, data }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const body = Buffer.concat(blocks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

module.exports = { packIcns, ICNS_TYPE_BY_SIZE };
