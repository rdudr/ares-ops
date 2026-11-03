// Makes the AR version of a KISEM field app from its current code (the `oracle` branch, which has
// the newer app kit: live updates, photo upload, company details from the Console), without
// touching the KISEM repo.
//
//   node clients/kisem-port/port-app.mjs <key> [--logo-dir tools/logos/out]
//
// What it does:
//   * copies the KISEM app's tracked files only (never untracked drafts), leaving out KISEM
//     branding, APKs, Android projects, reference data and KISEM docs;
//   * renames the kit lib/fox -> lib/ares and components/fox -> components/ares and points it at
//     the ARES server (api.arenergyservices.in), with AR's photo references and app header;
//   * puts AR's names on everything (the app's own AR name, ARES Console, Report Studio);
//   * builds for /field/<slug>/ on ops.arenergyservices.in (Next basePath + asset()), and keeps
//     the AR Android app id so a new APK installs over the old one;
//   * AR colours (navy actions on warm grey) and the AR logo.
// An existing AR app keeps its git history: the result is committed on the branch `kit-v2`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPS = path.resolve(HERE, '..', '..');
const DESK = 'C:/Users/risha/Desktop';
const AR_APPS = `${DESK}/process/AR Apps`;

// key: KISEM source, AR folder, app code, AR name, web slug, APK name, Android id, version.
export const APPS = {
  survey: { src: `${DESK}/fox-kisen`, dest: 'ares-brief', code: 'survey', name: 'BRIEF', kisem: ['FOX'], slug: 'brief', apk: 'ar-brief', appId: 'com.arenterprise.brief' },
  motor: { src: `${DESK}/process/MLA - KISEM`, dest: 'ares-mla', code: 'motor', name: 'Motor Pulse', kisem: ['MLA-KISEM', 'MLA'], slug: 'mla', apk: 'ar-motor-pulse', appId: 'com.arenterprise.mla' },
  heat: { src: `${DESK}/thermo-X`, dest: 'ares-boiler', code: 'heat', name: 'Boiler & Fuel', kisem: ['THERMO-X', 'Thermo-X', 'ThermoX', 'Thermo X'], slug: 'boiler', apk: 'ar-boiler-fuel', appId: 'com.arenterprise.boilerfuel' },
  textile: { src: `${DESK}/Jet EFF`, dest: 'ares-jet', code: 'textile', name: 'Dye House', kisem: ['JET-Eff', 'JET EFF', 'Jet EFF', 'Jet-EFF', 'JET-EFF', 'JET Eff'], slug: 'jet', apk: 'ar-dye-house', appId: 'com.arenterprise.jet' },
  air: { src: `${DESK}/A-CMP`, dest: 'ares-air', code: 'air', name: 'Air Findings', kisem: ['A-CMP'], slug: 'air', apk: 'ar-air-findings', appId: 'com.arenterprise.airfindings' },
  pump: { src: `${DESK}/process/Pump-Up`, dest: 'ares-pump', code: 'pump', name: 'Hydro Flow', kisem: ['Pump EFF', 'Pump-EFF', 'PUMP EFF', 'Pump-Up', 'PUMP-UP', 'Pump Up'], slug: 'pump', apk: 'ar-hydro-flow', appId: 'com.arenterprise.pumptesting' },
  cool: { src: `${DESK}/process/Zero Degree`, dest: 'ares-cooling', code: 'cool', name: 'Cool Zone', kisem: ['AC, AHU & Chiller', 'AC, AHU &amp; Chiller', 'Zero Degree', 'Zero-Degree', 'ZERO DEGREE'], slug: 'cooling', apk: 'ar-cool-zone', appId: 'com.arenterprise.ahucooling' },
  xmer: { src: `${DESK}/process/Xmer-Eff`, dest: 'ares-xmer', code: 'xmer', name: 'Trafo Check', kisem: ['Xmer-Eff', 'XMER-EFF', 'Xmer Eff'], slug: 'xmer', apk: 'ar-trafo-check', appId: 'com.arenterprise.trafocheck' },
  light: { src: `${DESK}/process/Lighting`, dest: 'ares-light', code: 'light', name: 'Lux Survey', kisem: [], slug: 'light', apk: 'ar-lux-survey', appId: 'com.arenterprise.luxsurvey' },
  dryer: { src: `${DESK}/process/Dryers`, dest: 'ares-dryer', code: 'dryer', name: 'Dryer Heat', kisem: [], slug: 'dryer', apk: 'ar-dryer-heat', appId: 'com.arenterprise.dryerheat' },
};

// Never copied: KISEM branding and data, build output, Android projects (made by the APK script).
const EXCLUDE = /^(android\/|releases\/|reference\/|docs\/|\.claude\/|\.idea\/|\.vscode\/|public\/brand\/|out\/|.*\.apk$|.*\.jks$|.*\.db$|(public\/)?APP logo\.png$|public\/iitgn[^/]*$|scripts\/make-logo\.mjs$|.*desktop\.ini$|AGENTS\.md$|CLAUDE\.md$|ar-logic\.json$|\.github\/workflows\/ar-logic-notify\.yml$)/i;
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|css|md|html|txt|yml|yaml)$|^\.(gitignore|env\.example)$/;

// Strings that must not change: file markers other copies of the app read back.
const KEEP = [/Zero Degree v\d/g, /"MLA v\d"/g, /KISEM-EXPORT/g];

function textEdits(s, cfg) {
  const kept = [];
  for (const re of KEEP) s = s.replace(re, m => { kept.push(m); return `\u0000${kept.length - 1}\u0000`; });
  s = s
    .replace(/@\/lib\/fox\//g, '@/lib/ares/').replace(/@\/components\/fox\//g, '@/components/ares/')
    .replace(/(["'])\.\.?\/(?:\.\.\/)*fox\//g, m => m.replace('fox/', 'ares/'))
    .replace(/lib\/fox\//g, 'lib/ares/').replace(/components\/fox\//g, 'components/ares/')
    .replace(/NEXT_PUBLIC_FOX_CONSOLE_URL/g, 'NEXT_PUBLIC_ARES_API')
    .replace(/https:\/\/console\.eassiitgn\.page/g, 'https://api.arenergyservices.in')
    .replace(/console\.eassiitgn\.page/g, 'ops.arenergyservices.in')
    .replace(/https:\/\/[a-z]+\.app\.eassiitgn\.page\/?/g, 'https://ops.arenergyservices.in/')
    .replace(/eassiitgn\.page/g, 'arenergyservices.in')
    .replace(/X-KISEM-App/g, 'X-ARES-App')
    .replace(/fox-photo:/g, 'ares-photo:')
    .replace(/FOX Console/g, 'ARES Console')
    .replace(/PostMan/g, 'Report Studio')
    .replace(/KISEM, IIT Gandhinagar|Kotak IIT Madras Save Energy Mission|IIT Gandhinagar|IITGN/g, 'AR Energy Services')
    .replace(/KISEM_DATA_SHARING\.md/g, 'DATA_SHARING.md (ARES Console docs)')
    .replace(/\bKISEM\b/g, 'AR')
    .replace(/\bkisem-/g, 'ares-').replace(/-kisem\b/g, '-ares');
  // Every app's name, where the kit lists them (e.g. "details from <app>").
  s = s.replace(/const APP_NAMES: Record<string, string> = \{[^}]*\};/, 'const APP_NAMES: Record<string, string> = {\n' +
    Object.values(APPS).map(a => `${a.code}: ${JSON.stringify(a.name)}`).join(', ') + ', power: "Grid Lens",\n};');
  for (const k of cfg.kisem) {
    // The KISEM product name, in UI text and strings only (not inside identifiers).
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`(^|[^A-Za-z0-9_$.\\/-])${esc}(?![A-Za-z0-9_$(])`, 'g'), (m, pre) => pre + cfg.name);
  }
  // The kit's own names: the `fox` client object and its storage keys.
  s = s.replace(/\bfox\b(?=[.,;:)\s}])/g, 'ares').replace(/\bfox(?= =| as\b)/g, 'ares').replace(/(["'`-])fox-(audit|work)/g, '$1ares-$2')
    .replace(/\bFOX\b/g, 'ARES')
    .replace(/AR · AR Energy Services/g, 'AR Energy Services')
    .replace(/placeholder="e\.g\. rishabh"/g, 'placeholder="Your Login ID"')
    .replace(/href=\{CONSOLE_URL\}/g, 'href="https://ops.arenergyservices.in/"');
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => kept[Number(i)]);
  return s;
}

// <img src="/x.png"> works only at the site root; on /field/<slug>/ it needs the base path.
function assetPaths(s) {
  let changed = false;
  s = s.replace(/\bsrc="(\/[^"]+\.(?:png|jpg|jpeg|svg|webp|ico))"/g, (m, p) => { changed = true; return `src={asset("${p}")}`; });
  if (changed && !/import \{[^}]*\basset\b[^}]*\} from "@\/lib\/ares\/base-path"/.test(s)) {
    const at = s.match(/^(?:"use client";?\s*\n)?/)[0].length;
    s = s.slice(0, at) + 'import { asset } from "@/lib/ares/base-path";\n' + s.slice(at);
  }
  return s;
}

function run(cmd, args, cwd) { return execFileSync(cmd, args, { cwd, encoding: 'utf8' }); }

export async function port(key, { logoDir = path.join(OPS, 'tools/logos/out'), version } = {}) {
  const cfg = APPS[key];
  if (!cfg) throw new Error(`Unknown app ${key}`);
  const dest = path.join(AR_APPS, cfg.dest);
  const existed = fs.existsSync(path.join(dest, '.git'));
  if (existed) {
    if (run('git', ['status', '--porcelain'], dest).trim()) throw new Error(`${cfg.dest} has uncommitted changes; stopping.`);
    const branches = run('git', ['branch', '--list', 'kit-v2'], dest).trim();
    run('git', branches ? ['checkout', '-q', 'kit-v2'] : ['checkout', '-q', '-b', 'kit-v2'], dest);
    for (const f of run('git', ['ls-files'], dest).split('\n').filter(Boolean)) fs.rmSync(path.join(dest, f), { force: true });
  } else {
    fs.mkdirSync(dest, { recursive: true });
    run('git', ['init', '-q', '-b', 'main'], dest);
  }
  const oldPkg = existed ? null : null;

  const files = run('git', ['ls-files'], cfg.src).split('\n').filter(Boolean);
  let copied = 0;
  for (const f of files) {
    if (EXCLUDE.test(f)) continue;
    const to = f.replace(/^lib\/fox\//, 'lib/ares/').replace(/^components\/fox\//, 'components/ares/');
    const target = path.join(dest, to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const name = path.basename(f);
    if (TEXT.test(name) && name !== 'package-lock.json') {
      let s = fs.readFileSync(path.join(cfg.src, f), 'utf8');
      s = textEdits(s, cfg);
      if (/\.tsx$/.test(f)) s = assetPaths(s);
      fs.writeFileSync(target, s);
    } else {
      fs.copyFileSync(path.join(cfg.src, f), target);
    }
    copied++;
  }

  // Identity: the kit's lib/ares/app.ts, and lib/ares/app-config.ts that the AR build scripts read.
  const appTs = path.join(dest, 'lib/ares/app.ts');
  let a = fs.readFileSync(appTs, 'utf8');
  a = a.replace(/name:\s*"[^"]*"/, `name: ${JSON.stringify(cfg.name)}`)
    .replace(/title:\s*"[^"]*"/, m => `title: ${JSON.stringify(cfg.name + (m.includes('·') ? ' · ' + m.split('·')[1].replace(/"$/, '').trim() : ''))}`)
    .replace(/storePrefix:\s*"[^"]*"/, `storePrefix: "ar-${cfg.slug}"`)
    .replace(/^\/\/.*$/m, '// This app\'s identity in the ARES Console (AR Energy Services). The only kit file (lib/ares/*) that');
  fs.writeFileSync(appTs, a);
  const tagline = (fs.readFileSync(path.join(OPS, 'lib/apps.js'), 'utf8').match(new RegExp(`code: '${cfg.code}'[^\\n]*tagline: '([^']*)'`)) || [])[1] || '';
  fs.writeFileSync(path.join(dest, 'lib/ares/app-config.ts'),
    `// What the AR build scripts read (scripts/web-build.mjs, scripts/android-apk.mjs). The code never\n// changes once data exists under it (PLATFORM_RULES.md §3).\nexport const APP = {\n  code: "${cfg.code}",\n  name: ${JSON.stringify(cfg.name)},\n  apk: "${cfg.apk}",\n  tagline: ${JSON.stringify(tagline)},\n} as const;\n`);
  fs.writeFileSync(path.join(dest, 'lib/ares/base-path.ts'),
    '// The web build on the AR server lives under /field/<app>/ (NEXT_PUBLIC_BASE_PATH at build time).\n// Next adds it to links and its own files; pictures given as "/x.png" go through asset().\nexport const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";\nexport const asset = (p: string) => `${BASE_PATH}${p}`;\n');

  // Next: same static export, under the base path when one is given.
  const nc = path.join(dest, 'next.config.ts');
  let n = fs.readFileSync(nc, 'utf8');
  if (!/basePath/.test(n)) n = n.replace(/output:\s*"export",/, 'output: "export",\n  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,');
  n = n.replace(/FOX Console|ARES Console/g, 'the ARES Console').replace(/the Oracle server serves/g, 'the AR server serves');
  fs.writeFileSync(nc, n);

  // Android: AR app id and name, AR server only.
  const cap = path.join(dest, 'capacitor.config.ts');
  if (fs.existsSync(cap)) {
    let c = fs.readFileSync(cap, 'utf8');
    c = c.replace(/appId:\s*['"][^'"]*['"]/, `appId: '${cfg.appId}'`).replace(/appName:\s*['"][^'"]*['"]/, `appName: ${JSON.stringify(cfg.name)}`);
    fs.writeFileSync(cap, c);
  }

  // Build scripts from the AR kit (web app under /field/<slug>/, signed APK with the AR key).
  for (const f of ['scripts/web-build.mjs', 'scripts/android-apk.mjs']) {
    fs.mkdirSync(path.join(dest, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(OPS, 'clients/ar-app-kit', f), path.join(dest, f));
  }
  const pkgPath = path.join(dest, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.name = cfg.dest;
  pkg.description = `${cfg.name}: AR Energy Services field app, synced with the ARES Console`;
  if (version) pkg.version = version;
  pkg.scripts = { ...pkg.scripts, 'build:mobile': 'next build', 'web:build': `node scripts/web-build.mjs --base field/${cfg.slug}`, 'android:apk': 'node scripts/android-apk.mjs' };
  for (const k of Object.keys(pkg.scripts)) if (/kisem|postman/i.test(k + pkg.scripts[k])) delete pkg.scripts[k];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  const lockPath = path.join(dest, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.name = cfg.dest; if (lock.packages?.['']) { lock.packages[''].name = cfg.dest; if (version) lock.packages[''].version = version; }
    if (version) lock.version = version;
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  }

  // AR colours: navy actions on warm grey (the KISEM look is black on #F5F5F5 with violet cards).
  const g = path.join(dest, 'app/globals.css');
  if (fs.existsSync(g)) {
    let s = fs.readFileSync(g, 'utf8');
    s = s.replace(/--background:\s*#f5f5f5;/i, '--background: #f4f2ee;')
      .replace(/--violet:\s*#2b2644;/i, '--violet: #15233f;')
      .replace(/--accent:\s*#000000;/i, '--accent: #1c3a8a;')
      .replace(/ARES Console look \(the same in every AR app\)[^*]*/, 'AR Energy Services look (the same in every AR app and the ARES Console): warm grey page, white\n   rounded cards, navy pill actions, deep navy feature cards. ');
    fs.writeFileSync(g, s);
  }
  // Black pill buttons -> AR navy (Tailwind classes in the screens).
  for (const f of walk(dest)) {
    if (!/\.(tsx|ts)$/.test(f)) continue;
    const s = fs.readFileSync(f, 'utf8');
    const t = s.replace(/\bbg-black\b/g, 'bg-[#1c3a8a]').replace(/\bhover:bg-neutral-800\b/g, 'hover:bg-[#15307a]').replace(/#2B2644/gi, '#15233F');
    if (t !== s) fs.writeFileSync(f, t);
  }

  // Logo and icons.
  const logo = path.join(logoDir, `${cfg.code}.png`);
  fs.mkdirSync(path.join(dest, 'public/brand'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(OPS, 'tools/logos/ar-mark.png'), path.join(dest, 'public/brand/ares-mark.png'));
  fs.copyFileSync(logo, path.join(dest, 'assets/app-logo.png'));
  // Every icon the app ships, redrawn from the AR logo (sharp from a KISEM app's install).
  const sharp = createRequire(`${DESK}/process/Xmer-Eff/node_modules/x.js`)('sharp');
  const icons = [['app/icon.png', 256], ['public/logo.png', 512], ['public/app-icon.png', 512], ['public/icon-512.png', 512], ['public/icon-192.png', 192], ['public/favicon.png', 32]];
  await Promise.all(icons.filter(([f]) => fs.existsSync(path.join(dest, f)) || ['app/icon.png', 'public/logo.png', 'public/icon-192.png', 'public/icon-512.png'].includes(f))
    .map(([f, size]) => sharp(logo).resize(size, size).png().toFile(path.join(dest, f))));
  const gen = path.join(dest, 'scripts/generate-icons.mjs');
  if (fs.existsSync(gen)) fs.writeFileSync(gen, fs.readFileSync(gen, 'utf8').replace(/resolve\("APP logo\.png"\)/, 'resolve("assets/app-logo.png")'));
  for (const f of walk(dest)) {
    if (!/\.(tsx|ts)$/.test(f)) continue;
    const s = fs.readFileSync(f, 'utf8');
    const t = s.replace(/\/brand\/(kisem|ares)-(mark|logo)\.png|\/brand\/iitgn-seal\.png/g, '/brand/ares-mark.png');
    if (t !== s) fs.writeFileSync(f, t);
  }

  // .gitignore: AR build output and secrets.
  const gi = path.join(dest, '.gitignore');
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!giText.includes('# AR app')) fs.appendFileSync(gi, '\n# AR app\n/android/\n/releases/\n/out/\n*.apk\n*.jks\n*.db\n.env*\n!.env.example\n');

  fs.writeFileSync(path.join(dest, 'README.md'), `# ${cfg.name}\n\n${tagline}\n\nAR Energy Services field app. Signs in with the ARES login and keeps its data, photos and\ncompany details in the ARES Console (ops.arenergyservices.in). Works offline and syncs when back\nonline.\n\n- Web: https://ops.arenergyservices.in/field/${cfg.slug}/ (\`npm run web:build\`, then \`ares-ops/deploy/field-web.sh ${cfg.slug}\`)\n- Android: \`npm run android:apk\` (signed with the AR key; see ares-ops/docs/AR_APP_GUIDE.md)\n\nThe calculations come from the matching KISEM app (made with ares-ops/clients/kisem-port).\n`);
  return { dest, copied, existed };
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.next', 'out', 'android'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const key = process.argv[2];
  const vi = process.argv.indexOf('--version');
  const r = await port(key, { version: vi > 0 ? process.argv[vi + 1] : undefined });
  console.log(`${APPS[key].name}: ${r.copied} files into ${r.dest}${r.existed ? ' (branch kit-v2)' : ' (new repo)'}`);
}
