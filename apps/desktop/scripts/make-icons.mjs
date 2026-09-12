// Generates the menu-bar template images. Committing a generator rather than a
// binary keeps the mark editable without a design tool in the loop.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources');

/** Two interlocking rings: the tandem mark. Alpha-only, as macOS template images require. */
function render(size) {
  const px = new Uint8Array(size * size); // coverage 0..255
  const s = size / 22;
  const radius = 5.1 * s;
  const stroke = 1.9 * s;
  const centres = [
    [7.4 * s, 11 * s],
    [14.6 * s, 11 * s],
  ];
  const SS = 3; // supersample factor, for edges that do not look chewed
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px0 = x + (sx + 0.5) / SS;
          const py0 = y + (sy + 0.5) / SS;
          for (const [cx, cy] of centres) {
            const d = Math.hypot(px0 - cx, py0 - cy);
            if (Math.abs(d - radius) <= stroke / 2) {
              hits++;
              break;
            }
          }
        }
      }
      px[y * size + x] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return px;
}

function png(size, alpha) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[o++] = 0;
      raw[o++] = 0;
      raw[o++] = 0;
      raw[o++] = alpha[y * size + x];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

mkdirSync(OUT, { recursive: true });
for (const [size, name] of [
  [22, 'trayTemplate.png'],
  [44, 'trayTemplate@2x.png'],
]) {
  writeFileSync(join(OUT, name), png(size, render(size)));
  console.log('wrote', name);
}
