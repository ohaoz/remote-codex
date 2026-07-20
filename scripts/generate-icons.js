#!/usr/bin/env node
'use strict';

/**
 * Renders the PWA icon set as real PNGs without any native image dependency.
 * The artwork mirrors web/icon.svg / web/icon-maskable.svg: warm paper tile,
 * hairline frame, prompt chevron in ink, terracotta cursor block.
 *
 *   node scripts/generate-icons.js
 *
 * Outputs (committed to the repo, served statically):
 *   web/icon-192.png / icon-512.png            purpose "any"   (transparent corners)
 *   web/icon-maskable-192.png / -512.png       purpose "maskable" (full bleed, 80% safe zone)
 *   web/icon-180.png                           apple-touch-icon (full bleed)
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/* ---------------- minimal PNG encoder ---------------- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;  // bit depth
  header[9] = 6;  // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- tiny SDF rasterizer ---------------- */
function roundRectSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  if (dx > 0 && dy > 0) return Math.hypot(dx, dy) - radius;
  return Math.max(dx, dy) - radius;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

const PAPER = [0xfa, 0xf9, 0xf5, 255];
const LINE = [0xdf, 0xdc, 0xd0, 255];
const INK = [0x1f, 0x1e, 0x1d, 255];
const ACCENT = [0xc9, 0x64, 0x42, 255]; // --accent (light theme)

/** Paint order matters: later shapes win. Coordinates live on a 512 canvas. */
function sceneFor(maskable) {
  if (maskable) {
    return [
      { kind: 'fill', cx: 256, cy: 256, hw: 256, hh: 256, r: 0, color: PAPER },
      { kind: 'stroke', cx: 256, cy: 256, hw: 154, hh: 154, r: 70, w: 9, color: LINE },
      { kind: 'polyline', pts: [[182, 198], [240, 256], [182, 314]], w: 28, color: INK },
      { kind: 'fill', cx: 303, cy: 256, hw: 37, hh: 58, r: 9, color: ACCENT },
    ];
  }
  return [
    { kind: 'fill', cx: 256, cy: 256, hw: 256, hh: 256, r: 116, color: PAPER },
    { kind: 'stroke', cx: 256, cy: 256, hw: 186, hh: 186, r: 84, w: 10, color: LINE },
    { kind: 'polyline', pts: [[167, 186], [237, 256], [167, 326]], w: 34, color: INK },
    { kind: 'fill', cx: 313, cy: 256, hw: 44, hh: 70, r: 10, color: ACCENT },
  ];
}

function sampleColor(scene, x, y) {
  let color = null; // transparent
  for (const shape of scene) {
    let inside = false;
    if (shape.kind === 'fill') {
      inside = roundRectSdf(x, y, shape.cx, shape.cy, shape.hw, shape.hh, shape.r) <= 0;
    } else if (shape.kind === 'stroke') {
      inside = Math.abs(roundRectSdf(x, y, shape.cx, shape.cy, shape.hw, shape.hh, shape.r)) <= shape.w / 2;
    } else {
      for (let i = 0; i + 1 < shape.pts.length; i += 1) {
        const [ax, ay] = shape.pts[i];
        const [bx, by] = shape.pts[i + 1];
        if (segmentDistance(x, y, ax, ay, bx, by) <= shape.w / 2) { inside = true; break; }
      }
    }
    if (inside) color = shape.color;
  }
  return color;
}

function renderPng(size, { maskable }) {
  const scene = sceneFor(maskable);
  const SS = 4; // 4×4 supersampling for smooth edges
  const scale = 512 / size;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = (x + (sx + 0.5) / SS) * scale;
          const py = (y + (sy + 0.5) / SS) * scale;
          const color = sampleColor(scene, px, py);
          if (color) {
            rSum += color[0];
            gSum += color[1];
            bSum += color[2];
            aSum += color[3];
          }
        }
      }
      const samples = SS * SS;
      const alpha = aSum / samples;
      const offset = (y * size + x) * 4;
      if (alpha > 0) {
        // premultiplied average back to straight alpha
        rgba[offset] = Math.round(rSum / (aSum / 255));
        rgba[offset + 1] = Math.round(gSum / (aSum / 255));
        rgba[offset + 2] = Math.round(bSum / (aSum / 255));
        rgba[offset + 3] = Math.round(alpha);
      }
    }
  }
  return encodePng(size, size, rgba);
}

const targets = [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-maskable-192.png', 192, { maskable: true }],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['icon-180.png', 180, { maskable: true }], // apple-touch-icon wants full bleed
];

const webDir = path.join(__dirname, '..', 'web');
for (const [name, size, options] of targets) {
  const file = path.join(webDir, name);
  fs.writeFileSync(file, renderPng(size, options));
  console.log(`wrote ${path.relative(process.cwd(), file)} (${size}×${size})`);
}
