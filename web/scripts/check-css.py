#!/usr/bin/env python3
"""No component in styles.css may pin a raw colour.

A raw hex or a `--vd-*`/`--green-*`/`--neutral-*` scale step inside a component
pins it to one ground, and the ink/paper toggle silently stops working for that
component — silently, because on the ground it was written against it looks
right. Two blocks are allowed to hold fixed values: the terminal's own palette
and the terminal itself, which is a picture of a terminal and keeps one palette
on both grounds deliberately.

Run from web/:  python3 scripts/check-css.py
"""
import re
import sys
from pathlib import Path

src = (Path(__file__).parent.parent / 'public' / 'styles.css').read_text().split('\n')


def span(start, end):
    """Line numbers from the line reading `start` to the next one reading `end`."""
    i = next(n for n, l in enumerate(src) if l.strip() == start)
    j = next(n for n, l in enumerate(src) if l.strip() == end and n > i)
    return range(i, j)


skip = set(span("THE TERMINAL'S OWN PALETTE", '}')) | set(span('THE TERMINAL', 'WHY'))

bad = [
    f'{n + 1}: {l.strip()}'
    for n, l in enumerate(src)
    if n not in skip and re.search(r'var\(--(neutral|green|vd)-|#[0-9a-fA-F]{3,8}\b', l)
]

print('\n'.join(bad) if bad else 'clean')
sys.exit(1 if bad else 0)
