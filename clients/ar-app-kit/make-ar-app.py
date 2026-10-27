"""Creates an AR Enterprise field app from a KISEM app's source, without touching the KISEM repo.

    python make-ar-app.py <app key>        (keys: see APPS below)

What it does (the app-specific screens are adapted by hand afterwards):
  * copies the KISEM app's tracked files, leaving out its server, logins, email, PostMan hand-off,
    KISEM docs, APKs, databases and branding images;
  * moves the pure formula files into vendor/kisem/<repo>/ unchanged and leaves a re-export at the
    original path, so the app keeps importing them as before;
  * installs the AR app kit (ARES sign-in, sync, screens), the AR theme with the app's accent colour,
    icons from the AR logo, app name and ids, the KISEM logic link, and docs.
Re-running it wipes and recreates the destination, so only use it before hand edits start.
"""
import json
import os
import re
import shutil
import subprocess
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = 'C:/Users/risha/Desktop'
DEST_ROOT = f'{DESKTOP}/process/AR Apps'
LOGOS = 'C:/Users/risha/Downloads/AR ENterprice'
TEMPLATE = f'{DEST_ROOT}/ares-pump'  # finished reference app: shared pages are copied from it
SYNC_KIT = f'{DESKTOP}/process/ares-ops/tools/kisem-logic-sync'

SCALES = {
    'amber': ['#fffbeb', '#fef3c7', '#fde68a', '#fcd34d', '#fbbf24', '#f5b400', '#d99a00', '#b37900', '#8f5f06', '#754e0b', '#432a02'],
    'green': ['#edfcf3', '#d3f8e1', '#aaf0c8', '#72e2a8', '#3acb83', '#1fb455', '#149245', '#12743a', '#135c31', '#124c2b', '#052a15'],
    'violet': ['#f5f3ff', '#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95', '#2e1065'],
    'brief': ['#eef4ff', '#d9e6ff', '#bcd3ff', '#8eb6ff', '#5a8dfb', '#3567f0', '#1f4fd6', '#1c40ad', '#1d388a', '#1d336f', '#152044'],
    'teal': ['#effefb', '#c8fff4', '#91fee9', '#52f4dc', '#1edfc8', '#06c3af', '#019c8f', '#067d74', '#0a635d', '#0d524d', '#01322f'],
}
STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]

APPS = {
    'air': dict(src='A-CMP', repo='rdudr/A-CMP', dest='ares-air', code='air', name='Air Findings',
                tagline='Compressed air audit — compressor efficiency, FAD and leak tests',
                logo='AIR Findings.png', accent='amber', app_id='com.arenterprise.airfindings', apk='ar-air-findings',
                vendor=['lib/compressor-calc.ts'],
                watch=['lib/compressor-excel.ts', 'lib/pdf-generator.ts', 'lib/store.ts', 'app/(console)/**', 'components/**']),
    'heat': dict(src='thermo-X', repo='rdudr/-thermo-X', dest='ares-boiler', code='heat', name='Boiler & Fuel',
                 tagline='Boiler and thermic fluid heater efficiency — direct and indirect methods',
                 logo='bOILER & fUEL.png', accent='green', app_id='com.arenterprise.boilerfuel', apk='ar-boiler-fuel',
                 vendor=['lib/boiler.ts', 'lib/steam-table.ts', 'lib/fuel-types.ts', 'lib/instrument-parser.ts'],
                 watch=['lib/data-exchange.ts', 'lib/pdf-generator.ts', 'lib/store.ts', 'components/boiler/**', 'app/(console)/**']),
    'cool': dict(src='process/Zero Degree', repo='rdudr/Zero-Degree', dest='ares-cooling', code='cool', name='AHU & Cooling',
                 tagline='AC, chiller, AHU and cooling-tower performance',
                 logo='AHU & Cooling.png', accent='violet', app_id='com.arenterprise.ahucooling', apk='ar-ahu-cooling',
                 vendor=['lib/calc.ts', 'lib/formulas.ts', 'lib/types.ts'],
                 watch=['lib/excel.ts', 'lib/merge.ts', 'lib/pdf.ts', 'lib/store.ts', 'app/(console)/**', 'components/**']),
    'textile': dict(src='Jet EFF', repo='rdudr/Jet-EFF', dest='ares-jet', code='textile', name='JET',
                    tagline='Jet dyeing machine efficiency and plant electrical survey',
                    logo='JET.png', accent='teal', app_id='com.arenterprise.jet', apk='ar-jet',
                    vendor=[],
                    watch=['lib/jet-excel.ts', 'lib/export-offline.ts', 'lib/export-pdf.ts', 'lib/store.ts', 'app/(console)/**', 'components/**']),
    'survey': dict(src='fox-kisen', repo='rdudr/fox-kisem', dest='ares-brief', code='survey', name='BRIEF',
                   tagline='Plant electrical survey — panels, motors, APFC and energy sources',
                   logo='BRIEF.png', accent='brief', app_id='com.arenterprise.brief', apk='ar-brief',
                   vendor=[],
                   watch=['lib/export-offline.ts', 'lib/store.ts', 'app/(console)/**', 'components/**']),
}

# Never copied: server, logins, email, PostMan hand-off, KISEM docs/branding (public/ holds KISEM and
# IITGN logos and sample client files), build artefacts.
EXCLUDE = re.compile(r'''^(
    android/ | releases/ | app/api/ | prisma/ | lib/api/ | lib/auth/ | lib/server/ | docs/ | reference/ |
    \.idea/ | \.vscode/ | \.claude/ | hooks/ | schemas/ | services/ | store/ | utils/ | styles/ |
    lib/(prisma|cleanup|mailer|postman-handoff|postman-bridge|sync|auth-store)\.ts$ |
    components/dashboard/mail-(send|credentials)-modal\.tsx$ | components/layout/upload-button\.tsx$ |
    components/auth/logout-button\.tsx$ | (proxy|middleware)\.ts$ |
    scripts/(prepare-vercel|upsert-user|db-setup|_import-check)\.mjs$ | scripts/(postman-[\w-]+|report-check)\.ts$ |
    public/ | app/icon\.png$ | assets/icon-[\w-]+\.png$ |
    [^/]*\.(apk|ico|db)$ | \.apk_seq$ | desktop\.ini$ | [^/]*\.png$ |
    (AGENTS|CLAUDE|README|DEPLOYMENT|BUG_FIXES|design|implementation_plan|task)\.md$ | vercel\.json$ | \.env\.example$
)''', re.X)

SHARED_FROM_TEMPLATE = ['app/login/page.tsx', 'app/change-password/page.tsx', 'app/audits/page.tsx', 'app/page.tsx',
                        'components/auth-guard.tsx', 'lib/auth-store.ts', 'scripts/kisem-sync.mjs',
                        '.github/workflows/kisem-logic-sync.yml', '.gitattributes']
KIT_FILES = ['lib/ares/api.ts', 'lib/ares/session.ts', 'lib/ares/sync.ts', 'lib/ares/collection-binding.ts', 'lib/ares/client-state.ts',
             'components/ares/ares-screens.tsx']


def theme_css(scale, accent_name):
    slate = ['#f3f6fb', '#e6ecf5', '#cdd7e6', '#a8b7cf', '#8193b2', '#5f7395', '#45577c', '#334462', '#20304d', '#15233f', '#0c1731']
    lines = ['@import "tailwindcss";', '',
             '/*', ' * AR Enterprise field-app theme. The screens use Tailwind\'s slate and cyan classes; here slate becomes',
             ' * the AR Enterprise navy and cyan becomes this app\'s accent (from its logo), so every screen takes the AR',
             ' * look without touching its logic.', ' */', '@theme {']
    lines += [f'  --color-slate-{s}: {c};' for s, c in zip(STEPS, slate)]
    lines += ['', f'  /* accent: {accent_name} */']
    lines += [f'  --color-cyan-{s}: {c};' for s, c in zip(STEPS, scale)]
    lines += [f'  --color-sky-{s}: {c};' for s, c in zip(STEPS, scale)]  # some screens use sky for the accent
    lines += ['}', '']
    return '\n'.join(lines)


def main(key):
    cfg = APPS[key]
    src = f"{DESKTOP}/{cfg['src']}"
    dest = f"{DEST_ROOT}/{cfg['dest']}"
    if os.path.exists(dest):
        shutil.rmtree(dest)
    os.makedirs(dest)
    files = subprocess.run(['git', 'ls-files'], cwd=src, capture_output=True, text=True, check=True).stdout.splitlines()
    copied = 0
    for f in files:
        if EXCLUDE.match(f):
            continue
        os.makedirs(os.path.dirname(os.path.join(dest, f)) or dest, exist_ok=True)
        shutil.copy2(os.path.join(src, f), os.path.join(dest, f))
        copied += 1

    # Formula files: KISEM's, unchanged, under vendor/kisem; a re-export keeps the old import path.
    repo_dir = cfg['repo'].split('/')[1].lstrip('-')
    for v in cfg['vendor']:
        target = os.path.join(dest, 'vendor', 'kisem', repo_dir, v)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.move(os.path.join(dest, v), target)
        rel = os.path.relpath(target, os.path.dirname(os.path.join(dest, v))).replace('\\', '/')
        rel = re.sub(r'\.ts$', '', rel)
        with open(os.path.join(dest, v), 'w', encoding='utf-8') as fh:
            fh.write('// KISEM\'s formulas, kept byte-for-byte in vendor/kisem/ and updated only through the KISEM logic\n'
                     '// sync (a reviewed pull request). Never edit them here.\n'
                     f'export * from "{rel}";\n')

    for f in KIT_FILES:
        os.makedirs(os.path.dirname(os.path.join(dest, f)), exist_ok=True)
        shutil.copy2(os.path.join(HERE, f), os.path.join(dest, f))
    for f in SHARED_FROM_TEMPLATE:
        os.makedirs(os.path.dirname(os.path.join(dest, f)) or dest, exist_ok=True)
        shutil.copy2(os.path.join(TEMPLATE, f), os.path.join(dest, f))

    with open(os.path.join(dest, 'lib/ares/app-config.ts'), 'w', encoding='utf-8') as fh:
        fh.write('// This app\'s identity inside the AR Enterprise suite (ARES). The code is fixed for good once data\n'
                 '// exists under it (PLATFORM_RULES.md §3).\n'
                 f'export const APP = {{\n  code: "{cfg["code"]}",\n  name: {json.dumps(cfg["name"])},\n'
                 f'  tagline: {json.dumps(cfg["tagline"])},\n}} as const;\n')

    # Theme: AR navy + accent; keep the KISEM app's own extra rules that are not theme/body.
    gpath = os.path.join(dest, 'app/globals.css')
    orig = open(gpath, encoding='utf-8').read() if os.path.exists(gpath) else ''
    rest = re.sub(r'@import\s+"tailwindcss";', '', orig)
    rest = re.sub(r':root\s*\{[^}]*\}', '', rest)
    rest = re.sub(r'@theme(\s+inline)?\s*\{[^}]*\}', '', rest)
    rest = re.sub(r'(^|\n)\s*(html,\s*)?body\s*\{[^}]*\}', r'\1', rest)
    rest = re.sub(r'::selection\s*\{[^}]*\}', '', rest)
    base = open(os.path.join(TEMPLATE, 'app/globals.css'), encoding='utf-8').read()
    base_tail = base[base.index(':root {'):]
    base_tail = base_tail.replace('rgba(79, 111, 245, 0.3)', 'rgba(255, 255, 255, 0.2)')
    css = theme_css(SCALES[cfg['accent']], cfg['accent']) + base_tail
    extra = re.sub(r'\n{3,}', '\n\n', rest).strip()
    if extra:
        css += '\n/* Kept from the original screens */\n' + extra + '\n'
    open(gpath, 'w', encoding='utf-8').write(css)

    # Icons from the AR logo.
    os.makedirs(os.path.join(dest, 'assets'), exist_ok=True)
    os.makedirs(os.path.join(dest, 'public'), exist_ok=True)
    shutil.copy2(os.path.join(LOGOS, cfg['logo']), os.path.join(dest, 'assets/app-logo.png'))
    im = Image.open(os.path.join(dest, 'assets/app-logo.png')).convert('RGB')
    for p, size in [('public/logo.png', 512), ('public/icon-512.png', 512), ('public/icon-192.png', 192),
                    ('public/favicon.png', 32), ('app/icon.png', 256)]:
        im.resize((size, size), Image.LANCZOS).save(os.path.join(dest, p), optimize=True)

    # package.json, Capacitor, scripts.
    pkg_path = os.path.join(dest, 'package.json')
    pkg = json.load(open(pkg_path, encoding='utf-8'))
    pkg['name'] = cfg['dest']
    pkg['description'] = f"{cfg['name']} — AR Enterprise field app ({cfg['tagline']}), synced through ARES"
    for dep in ['nodemailer', '@prisma/client', 'prisma', 'bcryptjs', 'jose', 'resend', 'zod']:
        pkg.get('dependencies', {}).pop(dep, None)
    for dep in ['@types/nodemailer', '@types/bcryptjs', 'prisma']:
        pkg.get('devDependencies', {}).pop(dep, None)
    scripts = pkg.setdefault('scripts', {})
    scripts['build'] = 'next build'
    scripts.pop('postinstall', None)
    for k in [k for k in scripts if k.startswith('db:') or 'postman' in k or 'upsert' in k or k == 'report:check']:
        scripts.pop(k)
    scripts['kisem:check'] = 'node scripts/kisem-sync.mjs --check'
    json.dump(pkg, open(pkg_path, 'w', encoding='utf-8'), indent=2)
    open(pkg_path, 'a', encoding='utf-8').write('\n')

    cap = os.path.join(dest, 'capacitor.config.ts')
    if os.path.exists(cap):
        c = open(cap, encoding='utf-8').read()
        quoted = r'''["'][^"']*["']'''  # the config may use single or double quotes
        c = re.sub(r'appId:\s*' + quoted, f'appId: "{cfg["app_id"]}"', c)
        c = re.sub(r'appName:\s*' + quoted, f'appName: {json.dumps(cfg["name"])}', c)
        c = re.sub(r'allowNavigation:\s*\[[^\]]*\],?', 'allowNavigation: ["api.arenergyservices.in"],', c)
        c = re.sub(r'\s*cleartext:\s*true,?', '', c)
        c = re.sub(r'allowMixedContent:\s*true', 'allowMixedContent: false', c)
        open(cap, 'w', encoding='utf-8').write(c)
    apk = os.path.join(dest, 'scripts/export-apk.mjs')
    if os.path.exists(apk):
        s = open(apk, encoding='utf-8').read()
        s = re.sub(r'`[\w-]+-v\$\{version\}\.apk`', f'`{cfg["apk"]}-v${{version}}.apk`', s)
        open(apk, 'w', encoding='utf-8').write(s)
    icons = os.path.join(dest, 'scripts/generate-icons.mjs')
    if os.path.exists(icons):
        s = open(icons, encoding='utf-8').read()
        s = re.sub(r'const src = resolve\("[^"]*"\);', 'const src = resolve("assets/app-logo.png");', s)
        open(icons, 'w', encoding='utf-8').write(s)

    # Ignore rules, env example, KISEM logic link.
    gi = os.path.join(dest, '.gitignore')
    with open(gi, 'a', encoding='utf-8') as fh:
        fh.write('\n# AR app\n/releases/*.apk\n*.apk\n*.db\n.env*\n!.env.example\n')
    shutil.copy2(os.path.join(TEMPLATE, '.env.example'), os.path.join(dest, '.env.example'))
    lock = {
        "$comment": f"Tracks which commit of {cfg['repo']} this AR app's calculations match. Updated by scripts/kisem-sync.mjs; do not edit 'files' or 'synced_commit' by hand.",
        "sources": [{"repo": cfg['repo'], "branch": "main",
                     "copy": [{"from": v, "to": f"vendor/kisem/{repo_dir}/{v}"} for v in cfg['vendor']],
                     "watch": cfg['watch'], "synced_commit": None, "files": {}}],
    }
    json.dump(lock, open(os.path.join(dest, 'kisem-logic.lock.json'), 'w', encoding='utf-8'), indent=2)
    manifest = {
        "$comment": "Put this file in the KISEM repo root as ar-logic.json. 'copy' = pure formula files the AR app reuses byte-for-byte. 'watch' = files whose changes are flagged for porting by hand.",
        "app": cfg['src'].split('/')[-1], "notify": [f"rdudr/{cfg['dest']}"], "copy": cfg['vendor'], "watch": cfg['watch'],
    }
    mname = {'air': 'A-CMP', 'heat': 'thermo-X', 'cool': 'Zero-Degree', 'textile': 'Jet-EFF', 'survey': 'fox-kisem'}[key]
    json.dump(manifest, open(os.path.join(SYNC_KIT, 'kisem-side/manifests', f'{mname}.ar-logic.json'), 'w', encoding='utf-8'), indent=2)
    json.dump(lock, open(os.path.join(SYNC_KIT, 'ar-side/locks', f'{mname}.kisem-logic.lock.json'), 'w', encoding='utf-8'), indent=2)

    print(f"{cfg['name']}: {copied} files copied to {dest}; formulas vendored: {', '.join(cfg['vendor']) or 'none (logic is inside screens)'}")


if __name__ == '__main__':
    main(sys.argv[1])
