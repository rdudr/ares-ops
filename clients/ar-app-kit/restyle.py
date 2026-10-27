"""Converts an AR app's screens from the dark KISEM look to the light AR Enterprise look.

    python restyle.py <app dir>

Colour classes are converted by their role, not swapped blindly, so contrast holds (WCAG AA):
dark panels -> white cards, light text -> dark ink, faint white borders -> visible borders,
light accent / status text -> the -800 shade, tinted backgrounds -> the -50/-100 tints.
Runs on .tsx files under app/ and components/ (not components/ui, which the kit provides, and not
vendor/, which is KISEM's code). Safe to run twice.
"""
import os
import re
import sys

APP = sys.argv[1]
VARIANTS = r'(?:(?:hover|focus|focus-visible|focus-within|active|group-hover|disabled|placeholder|sm|md|lg|xl|data-\[[^\]]+\]):)*'
COLOURS = 'cyan|sky|amber|emerald|green|red|rose|blue|indigo|violet|purple|teal|orange|yellow|lime|pink|fuchsia'

# Exact neutral replacements (prefix variants are preserved).
NEUTRAL = {
    'text-slate-50': 'text-slate-900', 'text-slate-100': 'text-slate-900', 'text-slate-200': 'text-slate-800',
    'text-slate-300': 'text-slate-700', 'text-slate-400': 'text-slate-600', 'text-slate-500': 'text-slate-600',
    'bg-white/5': 'bg-slate-50', 'bg-white/10': 'bg-slate-100', 'bg-white/15': 'bg-slate-100', 'bg-white/20': 'bg-slate-200',
    'border-white/5': 'border-slate-100', 'border-white/10': 'border-slate-200', 'border-white/15': 'border-slate-200',
    'border-white/20': 'border-slate-300', 'divide-white/5': 'divide-slate-100', 'divide-white/10': 'divide-slate-200',
    'shadow-black/20': 'shadow-slate-900/10', 'shadow-black/40': 'shadow-slate-900/15', 'shadow-black/30': 'shadow-slate-900/10',
    'bg-black/60': 'bg-slate-900/40', 'bg-black/70': 'bg-slate-900/45', 'bg-black/80': 'bg-slate-900/50', 'bg-black/50': 'bg-slate-900/35',
    'text-red-50': 'text-red-900',
}


def neutral_bg(shade, alpha):
    if shade in ('950', '900', '800'):
        return 'bg-white' if not alpha or int(alpha) >= 40 else 'bg-slate-50'
    return {'700': 'bg-slate-200', '600': 'bg-slate-200', '500': 'bg-slate-100'}.get(shade, f'bg-slate-{shade}')


def coloured(m):
    kind, fam, shade, alpha = m.group(1), m.group(2), int(m.group(3)), m.group(4)
    a = int(alpha) if alpha else 100
    if kind == 'text':
        return f'text-{fam}-800' if shade <= 600 else f'text-{fam}-{shade}'
    if kind == 'bg':
        if alpha:  # tinted panel
            return f'bg-{fam}-50' if a <= 20 else f'bg-{fam}-100' if a <= 40 else f'bg-{fam}-700'
        if shade in (500, 600):  # solid buttons and chips: dark enough for white text
            return f'bg-{fam}-700'
        if shade in (300, 400):  # was the lighter hover of a button: hover goes darker on light
            return f'bg-{fam}-800'
        if shade >= 900:
            return f'bg-{fam}-50'
        return f'bg-{fam}-{shade}'
    if kind == 'border':
        if not alpha:  # solid: light ones are already light-theme borders; mid ones become the strong accent
            return f'border-{fam}-{shade}' if shade <= 300 or shade >= 600 else f'border-{fam}-600'
        return f'border-{fam}-200' if a < 40 else f'border-{fam}-300'
    if kind == 'ring':
        return f'ring-{fam}-600/40'
    return m.group(0)


SOLID_BG = re.compile(rf'\bbg-(?:{COLOURS}|slate)-(?:6|7|8|9)00\b(?!/)')


def restyle_string(s):
    out = s
    for a, b in NEUTRAL.items():
        out = re.sub(rf'(?<![\w/-])({VARIANTS}){re.escape(a)}(?![\w/-])', lambda m: m.group(1) + b, out)
    out = re.sub(rf'(?<![\w/-])({VARIANTS})bg-slate-(950|900|800|700|600|500)(?:/(\d+))?(?![\w-])',
                 lambda m: m.group(1) + neutral_bg(m.group(2), m.group(3)), out)
    out = re.sub(rf'(?<![\w/-])({VARIANTS})((?:text|bg|border|ring)-(?:{COLOURS})-\d{{2,3}}(?:/\d+)?)(?![\w-])',
                 lambda m: m.group(1) + re.sub(rf'^(text|bg|border|ring)-({COLOURS})-(\d{{2,3}})(?:/(\d+))?$', coloured, m.group(2)), out)
    # White text stays only on a solid coloured background in the same class list; elsewhere it was
    # a heading on the dark theme and becomes dark ink.
    if re.search(r'(?<![\w/-])text-white(?![\w/-])', out) and not SOLID_BG.search(out):
        out = re.sub(rf'(?<![\w/-])({VARIANTS})text-white(?![\w/-])', lambda m: m.group(1) + 'text-slate-900', out)
    return out


STRING = re.compile(r'"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`')
PLACEHOLDER = re.compile(r'\s+placeholder=("[^"]*"|\{"[^"]*"\}|\{`[^`]*`\})')


EXAMPLE_PLACEHOLDERS = [
    # placeholder: "e.g. …" in field lists, and placeholder={cond ? "e.g. …" : "e.g. …"}
    (re.compile(r',\s*placeholder:\s*"e\.g\.[^"]*"'), ''),
    (re.compile(r'\s+placeholder=\{[^{}]*"e\.g\.[^{}]*\}'), ''),
    # a default "0" shown in every empty number box
    (re.compile(r'placeholder=\{placeholder \?\? \(text \? "" : "0"\)\}'), 'placeholder={placeholder}'),
]


def drop_placeholders(src):
    for pattern, repl in EXAMPLE_PLACEHOLDERS:
        src = pattern.sub(repl, src)
    return drop_literal_placeholders(src)


def drop_literal_placeholders(src):
    """Removes example placeholders. A field with no id / aria-label of its own (so no visible label
    points at it) keeps the text as its accessible name instead."""
    out, last = [], 0
    for m in PLACEHOLDER.finditer(src):
        tag_start = src.rfind('<', 0, m.start())
        labelled = re.search(r'\b(id|aria-label|aria-labelledby)=', src[tag_start:m.start()])
        out.append(src[last:m.start()])
        if not labelled:
            out.append(' aria-label=' + m.group(1))
        last = m.end()
    out.append(src[last:])
    return ''.join(out)


def process(path):
    src = open(path, encoding='utf-8', newline='').read()
    new = STRING.sub(lambda m: restyle_string(m.group(0)), src)
    # No example placeholders ("e.g. RISHABH", "Shree Textiles…"): labels and hints carry the meaning.
    new = drop_placeholders(new)
    if new != src:
        open(path, 'w', encoding='utf-8', newline='').write(new)
        return True
    return False


changed = 0
for root_dir in ('app', 'components'):
    for dp, dn, fn in os.walk(os.path.join(APP, root_dir)):
        if os.path.normpath(dp).endswith(os.path.normpath('components/ui')):
            continue
        for f in fn:
            if f.endswith('.tsx'):
                changed += process(os.path.join(dp, f))
print(f'{changed} files restyled in {APP}')
