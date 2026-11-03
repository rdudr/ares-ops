// Draws the AR app logos in the house style of the original AR set (warm grey ground, the AR
// Enterprise wave mark on top, the app's name in a coloured pill, a simple drawing).
//
//   node tools/logos/make-logos.mjs <path to a node_modules folder that has sharp>
//
// Writes tools/logos/out/<code>.png (1024 px, for the apps' own icons) and public/icons/<code>.png
// (256 px, for the Console). BRIEF, Air Findings and Boiler & Fuel keep the logos the team made;
// their files are copied in from tools/logos/keep/.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const req = createRequire(path.join(process.argv[2] || ROOT, 'x.js'));
const sharp = req('sharp');

const mark = fs.readFileSync(path.join(HERE, 'ar-mark.png')).toString('base64');
const NAVY = '#1C3A8A';

// Each drawing sits in a 1024 box; the pill and the mark are added around it.
const S = (body, extra = '') => `<g fill="none" stroke="${NAVY}" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</g>`;
const ART = {
  // Motor with a pulse line through it.
  motor: c => S(`<rect x="300" y="380" width="360" height="260" rx="40"/><path d="M660 470h110M660 550h110"/>
    <path d="M300 430h-60v160h60M360 380v-40h240v40"/><path d="M360 500h70l30-60 40 130 40-100 20 30h70" stroke="${c}" stroke-width="30"/>`),
  // Dyeing drum with fabric waves and a droplet.
  textile: c => S(`<circle cx="470" cy="500" r="170"/><circle cx="470" cy="500" r="60" fill="${c}" stroke="${c}"/>
    <path d="M330 600c40-30 80 30 120 0s80 30 120 0" stroke="${c}"/><path d="M700 330c30 45 50 75 50 100a50 50 0 0 1-100 0c0-25 20-55 50-100z" fill="${c}" stroke="${c}"/>`),
  // Pump casing on a pipe, with water.
  pump: c => S(`<circle cx="440" cy="500" r="140"/><circle cx="440" cy="500" r="40"/><path d="M440 360v-70h230M580 500h180v-80"/>
    <path d="M300 640h300"/><path d="M700 560c22 34 36 56 36 74a36 36 0 0 1-72 0c0-18 14-40 36-74z" fill="${c}" stroke="${c}"/>`),
  // Snowflake beside a fan.
  cool: c => S(`<g stroke="${c}"><path d="M330 320v320M191 400l278 160M191 560l278-160"/><path d="M300 345l30 30 30-30M300 615l30-30 30 30"/></g>
    <circle cx="660" cy="500" r="130"/><circle cx="660" cy="500" r="22" fill="${NAVY}"/>
    <path d="M660 478c-10-60 20-90 60-80M682 506c55 25 65 65 30 90M640 512c-50 30-90 15-90-25"/>`),
  // Two coils of a transformer and a tick.
  xmer: c => S(`<circle cx="410" cy="480" r="140"/><circle cx="590" cy="480" r="140"/><path d="M270 480h-70M730 480h70"/>
    <path d="M430 640l60 60 120-130" stroke="${c}" stroke-width="34"/>`),
  // Bulb over a grid of lux points.
  light: c => S(`<path d="M420 560c-50-40-80-90-80-150a160 160 0 0 1 320 0c0 60-30 110-80 150v50H420z" fill="${c}" stroke="${NAVY}"/>
    <path d="M440 650h120M460 690h80"/><g fill="${NAVY}" stroke="none">${[260, 380, 620, 740].map(x => `<circle cx="${x}" cy="700" r="18"/>`).join('')}</g>`),
  // Dryer drum with rising heat.
  dryer: c => S(`<rect x="290" y="420" width="420" height="230" rx="30"/><circle cx="500" cy="535" r="75"/><path d="M330 460h60"/>
    <g stroke="${c}"><path d="M400 380c-30-30 30-50 0-90M500 380c-30-30 30-50 0-90M600 380c-30-30 30-50 0-90"/></g>`),
  // A wave under a lens.
  power: c => S(`<circle cx="470" cy="480" r="170"/><path d="M590 600l130 130" stroke-width="40"/>
    <path d="M330 480c35-90 70-90 105 0s70 90 105 0 50-60 70-40" stroke="${c}" stroke-width="30"/>`),
  // Invoice with a rupee sign.
  bills: c => S(`<path d="M340 280h320v460l-55-35-55 35-55-35-55 35-50-35-50 35z"/>
    <path d="M440 380h130M440 430h130M505 430c60 0 60 90 0 90h-45l100 110" stroke="${c}"/>`),
  // Report page with a bar chart.
  report: c => S(`<path d="M340 270h250l90 90v390H340z"/><path d="M590 270v90h90"/>
    <g stroke="${c}" stroke-width="40"><path d="M420 660v-90M500 660v-170M580 660v-120"/></g>`),
};

const LOGOS = [
  { code: 'motor', name: 'MOTOR PULSE', color: '#2A45A3' },
  { code: 'textile', name: 'DYE HOUSE', color: '#019C8F' },
  { code: 'pump', name: 'HYDRO FLOW', color: '#3567F0' },
  { code: 'cool', name: 'COOL ZONE', color: '#7C3AED' },
  { code: 'xmer', name: 'TRAFO CHECK', color: '#D95F0E' },
  { code: 'light', name: 'LUX SURVEY', color: '#D99A00' },
  { code: 'dryer', name: 'DRYER HEAT', color: '#DC3B26' },
  { code: 'power', name: 'GRID LENS', color: '#0E8A6A' },
  { code: 'bills', name: 'GST BILLING', color: '#334462' },
  { code: 'report', name: 'REPORT STUDIO', color: '#1D388A' },
];

function svg({ code, name, color }) {
  const fs = name.length > 11 ? 92 : 108;
  const pillW = Math.min(900, name.length * fs * 0.62 + 120);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="#F4F2EE"/>
  <image x="392" y="40" width="240" height="160" xlink:href="data:image/png;base64,${mark}"/>
  <g transform="translate(0,40)">${ART[code](color)}</g>
  <rect x="${512 - pillW / 2}" y="800" width="${pillW}" height="150" rx="40" fill="${color}"/>
  <text x="512" y="${875 + fs * 0.36}" text-anchor="middle" font-family="'Arial Narrow', 'Roboto Condensed', Arial, sans-serif" font-weight="700" font-size="${fs}" fill="#fff" letter-spacing="1">${name.replace(/&/g, '&amp;')}</text>
</svg>`;
}

const out = path.join(HERE, 'out');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'public', 'icons'), { recursive: true });
for (const l of LOGOS) {
  const buf = Buffer.from(svg(l));
  await sharp(buf).png().toFile(path.join(out, `${l.code}.png`));
  await sharp(buf).resize(256, 256).png().toFile(path.join(ROOT, 'public', 'icons', `${l.code}.png`));
}
// The logos the team made for the apps whose names stay.
for (const [code, file] of [['survey', 'BRIEF.png'], ['air', 'AIR Findings.png'], ['heat', 'bOILER & fUEL.png']]) {
  const src = path.join(HERE, 'keep', file);
  await sharp(src).resize(1024, 1024).png().toFile(path.join(out, `${code}.png`));
  await sharp(src).resize(256, 256).png().toFile(path.join(ROOT, 'public', 'icons', `${code}.png`));
}
console.log('logos written:', fs.readdirSync(out).join(', '));
