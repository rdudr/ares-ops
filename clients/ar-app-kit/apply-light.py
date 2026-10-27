"""Applies the AR Enterprise light design and the shared app pieces to an AR app.

    python apply-light.py <app dir>

Copies the kit's base components, screens, layout, privacy page and ARES client; rebuilds
app/globals.css (warm neutral palette from the website + the app's own accent); converts the screens'
colour classes with restyle.py; switches the theme to light. Safe to run again after kit changes.
"""
import os
import re
import shutil
import subprocess
import sys

KIT = os.path.dirname(os.path.abspath(__file__))
APP = sys.argv[1]

# Website palette as Tailwind's "slate" (every pair used for text meets WCAG AA; see the guide).
NEUTRAL = ['#fbf9f4', '#f4f0e6', '#e7e0cf', '#cfc8b6', '#9aa190', '#66705e', '#525c4c', '#3d4733', '#2a3324', '#1d2219', '#141812']
STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]

COPY = [
    'components/ui/button.tsx', 'components/ui/card.tsx', 'components/ui/input.tsx', 'components/ui/label.tsx',
    'components/ui/badge.tsx', 'components/ui/textarea.tsx',
    'components/ares/ares-screens.tsx', 'components/ares/company-picker.tsx', 'components/ares/app-chrome.tsx',
    'lib/ares/api.ts', 'lib/ares/session.ts', 'lib/ares/sync.ts', 'lib/ares/collection-binding.ts', 'lib/ares/client-state.ts',
    'app/layout.tsx', 'app/privacy/page.tsx',
]
for f in COPY:
    os.makedirs(os.path.dirname(os.path.join(APP, f)), exist_ok=True)
    shutil.copy2(os.path.join(KIT, f), os.path.join(APP, f))

# globals.css: keep the app's accent scale (cyan, and sky where used) and anything app-specific.
gpath = os.path.join(APP, 'app/globals.css')
old = open(gpath, encoding='utf-8').read()
accent = re.findall(r'  --color-cyan-(\d+): (#[0-9a-fA-F]{6});', old)
if len(accent) != 11:
    raise SystemExit('could not find the app accent scale in globals.css')
kept = ''
if '/* Kept from the original screens */' in old:
    kept = old.split('/* Kept from the original screens */', 1)[1]
    kept = re.sub(r'(^|\n)\s*(html,\s*)?body\s*\{[^}]*\}', r'\1', kept).strip()
lines = ['@import "tailwindcss";', '', '/* AR Enterprise app theme: website neutrals as "slate", this app\'s accent as "cyan" (and "sky"). */',
         '@theme {', '  --font-sans: var(--font-ar-sans);', '  --font-display: var(--font-ar-display);']
lines += [f'  --color-slate-{s}: {c};' for s, c in zip(STEPS, NEUTRAL)]
lines += [f'  --color-cyan-{s}: {c};' for s, c in accent]
lines += [f'  --color-sky-{s}: {c};' for s, c in accent]
lines += ['}', '']
css = '\n'.join(lines) + open(os.path.join(KIT, 'app/globals.base.css'), encoding='utf-8').read()
if kept:
    css += '\n/* Kept from the original screens */\n' + kept + '\n'
open(gpath, 'w', encoding='utf-8').write(css)

# Light theme only (the screens are designed for it).
prov = os.path.join(APP, 'components/providers/app-providers.tsx')
if os.path.exists(prov):
    p = open(prov, encoding='utf-8').read()
    p = re.sub(r'defaultTheme="\w+"', 'defaultTheme="light"', p)
    p = p.replace(' enableSystem', ' forcedTheme="light"')
    open(prov, 'w', encoding='utf-8').write(p)

# Other base components the kit does not ship (e.g. select.tsx) get the same colour conversion.
src = open(os.path.join(KIT, 'restyle.py'), encoding='utf-8').read().split('changed = 0')[0]
ns = {}
argv, sys.argv = sys.argv, ['restyle.py', APP]
exec(src, ns)
sys.argv = argv
for f in os.listdir(os.path.join(APP, 'components/ui')):
    if f.endswith('.tsx') and f not in [os.path.basename(c) for c in COPY]:
        ns['process'](os.path.join(APP, 'components/ui', f))

subprocess.run([sys.executable, os.path.join(KIT, 'restyle.py'), APP], check=True)

# The skip link jumps to the main content.
shell = os.path.join(APP, 'components/layout/console-shell.tsx')
if os.path.exists(shell):
    s = open(shell, encoding='utf-8').read()
    if 'id="main"' not in s:
        s = s.replace('<main className="flex-1">', '<main id="main" tabIndex={-1} className="flex-1 focus:outline-none">', 1)
    # Keyboard and screen readers: current page announced, phone menu is a dialog that Escape closes.
    if 'aria-current' not in s:
        s = s.replace('          onClick={onClick}\n          className={cn(', '          onClick={onClick}\n          aria-current={active ? "page" : undefined}\n          className={cn(', 1)
    if 'aria-modal' not in s:
        s = s.replace('<div className="fixed inset-0 z-[100] lg:hidden">',
                      '<div className="fixed inset-0 z-[100] lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">', 1)
    if 'Escape' not in s:
        s = s.replace('import { useState } from "react";', 'import { useEffect, useState } from "react";', 1)
        s = s.replace('  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);\n',
                      '  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);\n'
                      '  useEffect(() => {\n'
                      '    if (!isMobileMenuOpen) return;\n'
                      '    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setIsMobileMenuOpen(false); };\n'
                      '    document.addEventListener("keydown", onKey);\n'
                      '    return () => document.removeEventListener("keydown", onKey);\n'
                      '  }, [isMobileMenuOpen]);\n', 1)
    # Hover / focus for the menu links and the privacy link in the side panel.
    s = s.replace('active ? "bg-cyan-50 font-medium text-cyan-800" : "text-slate-700 hover:bg-slate-50"',
                  'active ? "bg-cyan-50 font-semibold text-cyan-900" : "text-slate-700 hover:bg-white hover:text-slate-900 hover:shadow-sm"')
    if '/privacy' not in s:
        s = s.replace('          <nav className="flex flex-col gap-1">{navLinks()}</nav>\n',
                      '          <nav className="flex flex-col gap-1">{navLinks()}</nav>\n'
                      '          <Link href="/privacy" className="px-3 text-xs text-slate-600 underline-offset-4 hover:text-slate-900 hover:underline">Privacy &amp; storage</Link>\n', 1)
    open(shell, 'w', encoding='utf-8').write(s)
print(f'light design applied to {APP}')
