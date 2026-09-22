#!/usr/bin/env python3
"""Every internal link and anchor in the built site has to resolve.

Astro will not tell you about a `/docs/typo/` in hand-written HTML or in an
.mdx body, and a broken link in a manual is worse than a missing page: it reads
as "this is documented somewhere" and sends the reader looking.

Run from web/, after `npm run build`:  python3 scripts/check-links.py
"""
import re
import sys
from pathlib import Path

dist = Path(__file__).parent.parent / 'dist'
if not dist.is_dir():
    sys.exit('dist/ is not there — run `npm run build` first')

pages = list(dist.rglob('*.html'))
text = {f: f.read_text('utf8', errors='ignore') for f in pages}
ids = {f: set(re.findall(r'id="([^"]+)"', t)) for f, t in text.items()}


def resolve(href):
    """The file a root-relative href would be served from, or None."""
    p = href.split('#')[0].split('?')[0].lstrip('/')
    candidates = ['index.html'] if p == '' else [p, p.rstrip('/') + '/index.html', p.rstrip('/') + '.html']
    for c in candidates:
        if (dist / c).is_file():
            return dist / c
    return None


bad = []
for f, t in text.items():
    where = f.relative_to(dist)
    for h in set(re.findall(r'href="(/[^"]*)"', t)):
        target = resolve(h)
        if target is None:
            bad.append(f'{where} -> {h}  (no page)')
        elif '#' in h and h.split('#', 1)[1] not in ids[target]:
            bad.append(f'{where} -> {h}  (no anchor)')
    for x in set(re.findall(r'href="#([^"]+)"', t)):
        if x not in ids[f]:
            bad.append(f'{where} -> #{x}  (no anchor)')

print('\n'.join(sorted(bad)) if bad else f'{len(pages)} pages, all links and anchors resolve')
sys.exit(1 if bad else 0)
