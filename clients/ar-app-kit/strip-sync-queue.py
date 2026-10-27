"""Removes the KISEM "report email" queue (SyncJob / syncQueue) from an app's lib/store.ts and renames
its on-device storage key. ARES sync replaces it.

    python strip-sync-queue.py <app dir> <new storage key>
"""
import re
import sys

app, key = sys.argv[1], sys.argv[2]
p = f'{app}/lib/store.ts'
s = open(p, encoding='utf-8', newline='').read()
nl = '\r\n' if '\r\n' in s else '\n'


def drop_block(text, start_pat):
    """Remove `export type X = { ... };` with balanced braces."""
    m = re.search(start_pat, text)
    if not m:
        return text
    i = text.index('{', m.start())
    depth = 0
    for j in range(i, len(text)):
        depth += {'{': 1, '}': -1}.get(text[j], 0)
        if depth == 0:
            end = text.index(';', j) + 1
            while end < len(text) and text[end] in '\r\n':
                end += 1
            return text[:m.start()] + text[end:]
    raise SystemExit('unbalanced SyncJob type')


s = drop_block(s, r'export type SyncJob = \{')
s = re.sub(r'[ \t]*syncQueue: SyncJob\[\];\r?\n', '', s)
s = re.sub(r'[ \t]*(addJobToQueue|updateJobStatus|pruneQueue): \([^)]*\) => void;\r?\n', '', s)
s = re.sub(r'[ \t]*syncQueue: \[\],\r?\n', '', s)
s = re.sub(r',\s*syncQueue: \[\]', '', s)

# Implementations: from addJobToQueue to the end of the state object (just before the persist options).
m = re.search(r'\r?\n[ \t]*addJobToQueue: \(job\)', s)
if m:
    end = re.search(r'\r?\n[ \t]*\}\),\r?\n[ \t]*\{\r?\n[ \t]*name:', s[m.start():])
    if not end:
        raise SystemExit('could not find the end of the queue actions')
    s = s[:m.start()] + s[m.start() + end.start():]
    s = re.sub(r',(\s*)$', r'\1', s[:m.start()]) + s[m.start():]
    s = re.sub(r',([ \t]*\r?\n[ \t]*\}\),\r?\n[ \t]*\{\r?\n[ \t]*name:)', r'\1', s)

s = re.sub(r"name: ['\"][^'\"]+['\"]", f"name: '{key}'", s, count=1)
open(p, 'w', encoding='utf-8', newline='').write(s)
left = [w for w in ('SyncJob', 'syncQueue', 'addJobToQueue', 'pruneQueue', 'updateJobStatus') if w in s]
print('store.ts updated' + (f' — still mentions {left}' if left else ''))
