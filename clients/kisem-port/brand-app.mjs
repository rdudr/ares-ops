// AR branding for an AR field app folder (run by port-app.mjs, and on its own for apps already ported):
//
//   node clients/kisem-port/brand-app.mjs <app code> <app folder> [<app code> <app folder> ...]
//
// - the AR logo (tools/logos/ar-logo-text.png) where the app shows the AR mark;
// - every app icon from the app's AR logo (tools/logos/out/<code>.png);
// - AR colours: the AR logo green for actions, deep green for feature cards;
// - no KISEM leftovers: old KISEM notes (with team e-mail addresses), a KISEM client's name in test
//   data, "Kisem" in the phone's photo folder names.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = path.resolve(HERE, '..', '..');
const sharp = createRequire('C:/Users/risha/Desktop/process/Xmer-Eff/node_modules/x.js')('sharp');

const GREEN = '#0b4a22';
const COLOURS = [
  [/#1c3a8a/gi, GREEN], [/#15307a/gi, '#083a1a'], [/#15233f/gi, '#0f2a1a'], [/#2b2644/gi, '#0f2a1a'],
  [/rgba\(17,\s*12,\s*46,/g, 'rgba(8,30,16,'],
];
const TEXT = [
  [/Shree Mahadev Silk Mills Pvt\. Ltd\./g, 'Sample Textiles Pvt. Ltd.'], [/Shree%20Mahadev%20Silk%20Mills%20Pvt\.%20Ltd\./g, 'Sample%20Textiles%20Pvt.%20Ltd.'],
  [/Mahadev Silk Mills/g, 'Sample Textiles'], [/cmp-shree-mahadev/g, 'cmp-sample'],
  [/FoxKisemPhotos/g, 'BriefPhotos'], [/MLAKisemMotorPhotos/g, 'ARPhotos'],
];
const OLD_NOTES = ['BUG_FIXES.md', 'DEPLOYMENT.md', 'design.md', 'implementation_plan.md', 'task.md'];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.next', 'out', 'android', 'releases'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

export async function brandApp(code, dir) {
  for (const f of OLD_NOTES) fs.rmSync(path.join(dir, f), { force: true });
  fs.mkdirSync(path.join(dir, 'public/brand'), { recursive: true });
  fs.copyFileSync(path.join(OPS, 'tools/logos/ar-logo-text.png'), path.join(dir, 'public/brand/ares-mark.png'));
  const logo = path.join(OPS, 'tools/logos/out', `${code}.png`);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.copyFileSync(logo, path.join(dir, 'assets/app-logo.png'));
  const icons = [['app/icon.png', 256], ['public/logo.png', 512], ['public/app-icon.png', 512], ['public/icon-512.png', 512], ['public/icon-192.png', 192], ['public/favicon.png', 32]];
  for (const [f, size] of icons) {
    if (fs.existsSync(path.join(dir, f)) || !f.includes('app-icon')) await sharp(logo).resize(size, size).png().toFile(path.join(dir, f));
  }
  // The Android icon script reads the app logo (it pointed at the KISEM logo file).
  const gen = path.join(dir, 'scripts/generate-icons.mjs');
  if (fs.existsSync(gen)) fs.writeFileSync(gen, fs.readFileSync(gen, 'utf8').replace(/resolve\("[^"]*\.(png|jpe?g)"\)/, 'resolve("assets/app-logo.png")'));
  let changed = 0;
  for (const f of walk(dir)) {
    if (!/\.(tsx?|mjs|css|json)$/.test(f) || f.endsWith('package-lock.json')) continue;
    const s = fs.readFileSync(f, 'utf8');
    let t = s;
    for (const [a, b] of [...COLOURS, ...TEXT]) t = t.replace(a, b);
    if (t !== s) { fs.writeFileSync(f, t); changed++; }
  }
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) console.log(`${args[i + 1]}: ${await brandApp(args[i], args[i + 1])} files recoloured or cleaned`);
}
