// Pictures for the demo company (lib/demo.js): small PNGs drawn here, so the demo needs no files of
// its own. A "photo" is a simple scene (wall, floor, a machine in the equipment's own colour);
// a "thermal" is a false-colour heat map with a hot spot; the logo and the site photo are plain
// marks. Invented pictures only, labelled as demo in their captions.
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** RGB pixels (w × h × 3) as a PNG. */
function png(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const hash = s => crypto.createHash('sha256').update(String(s)).digest();
const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l), f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [clamp(f(0) * 255), clamp(f(8) * 255), clamp(f(4) * 255)];
}

const W = 480, H = 360;

/** A photo-like scene for one piece of equipment. */
export function demoPhoto(tag) {
  const g = hash(tag), hue = g[0] * 360 / 255;
  const body = hsl(hue, 0.45, 0.45), dark = hsl(hue, 0.5, 0.28), panel = hsl((hue + 180) % 360, 0.15, 0.85);
  const px = Buffer.alloc(W * H * 3);
  const bx = 120 + (g[1] % 60), by = 90 + (g[2] % 40), bw = 200 + (g[3] % 60), bh = 170;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let c;
    if (y < 230) { const t = y / 230; c = [clamp(205 - 25 * t), clamp(208 - 25 * t), clamp(200 - 22 * t)]; }      // wall
    else { const t = (y - 230) / 130; c = [clamp(150 - 40 * t), clamp(150 - 40 * t), clamp(145 - 40 * t)]; }      // floor
    if (y > 225 && y < 233) c = [110, 110, 105];                                                                     // skirting
    if (x > bx && x < bx + bw && y > by && y < by + bh) {                                                           // machine
      const shade = 1 - 0.35 * ((x - bx) / bw);
      c = body.map(v => clamp(v * shade));
      if (x > bx + 20 && x < bx + 90 && y > by + 20 && y < by + 70) c = panel;                                      // name-plate
      if (Math.abs(y - (by + bh - 25)) < 3) c = dark;
      if ((x - (bx + bw - 45)) ** 2 + (y - (by + 50)) ** 2 < 22 ** 2) c = dark;                                    // a gauge
    }
    if (y > by + bh && y < by + bh + 14 && x > bx - 10 && x < bx + bw + 10) c = [60, 60, 58];                       // plinth
    const n = ((x * 31 + y * 17 + g[4]) % 7) - 3;                                                                    // grain
    px[(y * W + x) * 3] = clamp(c[0] + n); px[(y * W + x) * 3 + 1] = clamp(c[1] + n); px[(y * W + x) * 3 + 2] = clamp(c[2] + n);
  }
  return png(W, H, px);
}

/** A thermal-camera-like image: false colour with one hot spot. */
export function demoThermal(tag, hot = 0.8) {
  const g = hash(`${tag}:thermal`);
  const hx = 140 + (g[0] % 200), hy = 110 + (g[1] % 140), rad = 70 + (g[2] % 50);
  const px = Buffer.alloc(W * H * 3);
  const iron = t => { // black - purple - red - orange - yellow - white
    const stops = [[0, [0, 0, 20]], [0.25, [80, 0, 120]], [0.5, [200, 30, 40]], [0.7, [245, 120, 0]], [0.88, [255, 220, 40]], [1, [255, 255, 230]]];
    for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) { const [a, ca] = stops[i - 1], [b, cb] = stops[i], k = (t - a) / (b - a); return ca.map((v, j) => clamp(v + (cb[j] - v) * k)); }
    return stops[stops.length - 1][1];
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.sqrt((x - hx) ** 2 + (y - hy) ** 2) / rad;
    let t = 0.22 + 0.12 * Math.sin(x / 40) * Math.cos(y / 50) + hot * Math.exp(-d * d * 1.4);
    if (x > 60 && x < 420 && y > 60 && y < 300) t += 0.12;                                                          // the warm body
    const c = iron(Math.max(0, Math.min(1, t)));
    px[(y * W + x) * 3] = c[0]; px[(y * W + x) * 3 + 1] = c[1]; px[(y * W + x) * 3 + 2] = c[2];
  }
  for (let x = W - 26; x < W - 12; x++) for (let y = 40; y < H - 40; y++) {                                          // the scale bar
    const c = iron(1 - (y - 40) / (H - 80)); px[(y * W + x) * 3] = c[0]; px[(y * W + x) * 3 + 1] = c[1]; px[(y * W + x) * 3 + 2] = c[2];
  }
  return png(W, H, px);
}

/** The demo company's logo: a coloured disc with a ring, on white. */
export function demoLogo() {
  const S = 256, px = Buffer.alloc(S * S * 3, 255);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const d = Math.sqrt((x - 128) ** 2 + (y - 128) ** 2);
    let c = null;
    if (d < 110 && d > 92) c = [43, 38, 68];
    else if (d < 80) c = (x + y) % 64 < 32 ? [0, 122, 120] : [0, 150, 140];
    if (c) { px[(y * S + x) * 3] = c[0]; px[(y * S + x) * 3 + 1] = c[1]; px[(y * S + x) * 3 + 2] = c[2]; }
  }
  return png(S, S, px);
}

/** The site photograph: sky, a factory shed and a gate. */
export function demoSite() {
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let c = y < 170 ? [clamp(130 + y * 0.6), clamp(175 + y * 0.3), 235] : [clamp(120 - (y - 170) * 0.2), 125, 110];
    if (y > 90 && y < 230 && x > 70 && x < 410) c = [210, 205, 195];                                                  // shed
    if (y > 70 && y <= 90 && x > 60 + (90 - y) && x < 420 - (90 - y)) c = [120, 60, 50];                             // roof
    if (y > 150 && y < 230 && x > 210 && x < 270) c = [70, 90, 110];                                                  // door
    if (y > 200 && y < 250 && (x < 40 || x > 440) && x % 12 < 4) c = [60, 60, 60];                                   // gate
    px[(y * W + x) * 3] = c[0]; px[(y * W + x) * 3 + 1] = c[1]; px[(y * W + x) * 3 + 2] = c[2];
  }
  return png(W, H, px);
}
