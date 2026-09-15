#!/usr/bin/env node
/**
 * The static social card. SEO.md §4 `[PR]`.
 *
 * "A dynamically generated OG image would be ideal, but image generation at request time costs
 * Worker CPU (10 ms limit) and every card view costs bandwidth. Instead: a single static
 * 1200×630 brand card (<= 25 KB, generated once at build) is used site-wide, and
 * `twitter:card` is `summary` rather than `summary_large_image` so the preview stays small."
 *
 * WHY A HAND-ROLLED PNG ENCODER. The card is a flat brand-colour ground with the wordmark's
 * letter on it — four rectangles and two parallelograms. Every library that could draw that
 * (sharp, canvas, resvg, satori) is tens of megabytes of native build for one 3 KB file that
 * changes once a year, on a project whose whole premise is not spending what it does not need
 * to. PNG's format is a few chunks and a CRC; zlib is in Node. So this writes the file itself,
 * in about a hundred lines, with no dependency at all.
 *
 * DESIGN_SYSTEM.md §11 allows no symbol and no icon mark at launch, so there is none here: the
 * letter is the wordmark's own initial, in --brand on --surface, and the same shape as
 * public/icon.svg. When the name is settled this file and that one change together.
 *
 * Run: npm run og:card   (writes apps/web/public/og.png and prints its size)
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "apps", "web", "public", "og.png");

const WIDTH = 1200;
const HEIGHT = 630;

// styles/tokens.css: --brand and --surface. Two copies of a colour is two colours eventually,
// so if these change, they change there first and here second.
const BRAND = [0x1c, 0x3f, 0x94];
const SURFACE = [0xfb, 0xfb, 0xf9];

/** A 3-byte-per-pixel canvas, filled with the brand colour. */
const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
  pixels[i * 3] = BRAND[0];
  pixels[i * 3 + 1] = BRAND[1];
  pixels[i * 3 + 2] = BRAND[2];
}

function set(x, y, colour) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const offset = (y * WIDTH + x) * 3;
  pixels[offset] = colour[0];
  pixels[offset + 1] = colour[1];
  pixels[offset + 2] = colour[2];
}

function rect(x0, y0, w, h, colour) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) set(x, y, colour);
  }
}

/**
 * A filled quadrilateral between two vertical strokes, used for the M's diagonals.
 * Walks each row and fills between the two edges, which is exact for a shape this simple and
 * needs no polygon rasteriser.
 */
function diagonal(xTop, xBottom, y0, y1, thickness, colour) {
  for (let y = y0; y <= y1; y += 1) {
    const t = (y - y0) / (y1 - y0);
    const x = Math.round(xTop + (xBottom - xTop) * t);
    rect(x, y, thickness, 1, colour);
  }
}

// The letter, centred: two uprights and two strokes meeting in the middle. Proportions follow
// the wordmark's weight (Archivo 700), which is a stem roughly a sixth of the cap height.
const CAP = 340;
const TOP = Math.round((HEIGHT - CAP) / 2);
const BOTTOM = TOP + CAP;
const STEM = 56;
const SPAN = 420;
const LEFT = Math.round((WIDTH - SPAN) / 2);
const RIGHT = LEFT + SPAN - STEM;
const MIDDLE = Math.round(WIDTH / 2 - STEM / 2);

rect(LEFT, TOP, STEM, CAP, SURFACE);
rect(RIGHT, TOP, STEM, CAP, SURFACE);
diagonal(LEFT, MIDDLE, TOP, BOTTOM - Math.round(CAP * 0.28), STEM, SURFACE);
diagonal(RIGHT, MIDDLE, TOP, BOTTOM - Math.round(CAP * 0.28), STEM, SURFACE);

// A hairline rule under the letter, the same gesture the interface uses everywhere instead of
// ornament: a line, and nothing else.
rect(LEFT, BOTTOM + 48, SPAN, 4, SURFACE);

/* ── PNG ──────────────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type 2: truecolour, no alpha
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

// One filter byte per scanline. Filter 0 (none) costs a byte a row and compresses to nothing on
// an image this flat — a card of two colours deflates to a couple of kilobytes either way.
const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 3));
for (let y = 0; y < HEIGHT; y += 1) {
  const rowStart = y * (1 + WIDTH * 3);
  raw[rowStart] = 0;
  pixels.copy(raw, rowStart + 1, y * WIDTH * 3, (y + 1) * WIDTH * 3);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(OUT, png);
console.log(`${OUT}  ${WIDTH}×${HEIGHT}  ${(png.length / 1024).toFixed(1)} KB`);
