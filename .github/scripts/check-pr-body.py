#!/usr/bin/env python3
"""Check a PR body against the required sections in the EveryField PR template.

Usage: PR_BODY="..." python3 .github/scripts/check-pr-body.py [template]
Each level-2 heading in the template (outside HTML comments) is a required section. The body
must have each heading with the exact text, in the same order, each with real content, and an
`EVF-Author: anthropic|openai` line after the last section. Replace with W1's evf validator
when it exists.
"""
import os
import re
import sys
from pathlib import Path

TEMPLATE = Path(sys.argv[1] if len(sys.argv) > 1 else '.agents/skills/everyfield-pr/template.md')
AUTHOR = re.compile(r'^EVF-Author: (anthropic|openai)$')


def strip_comments(text):
    return re.sub(r'<!--.*?-->', '', text, flags=re.S)


def main():
    if not TEMPLATE.exists():
        print(f'NOTICE: {TEMPLATE} does not exist yet; no PR body sections to check.')
        return 0
    required = [l.strip() for l in strip_comments(TEMPLATE.read_text()).splitlines() if l.startswith('## ')]
    lines = strip_comments(os.environ.get('PR_BODY', '').replace('\r\n', '\n')).splitlines()
    headings = [(i, l.strip()) for i, l in enumerate(lines) if l.startswith('## ')]
    errors = []
    found = [h for _, h in headings if h in required]
    if found != required:
        missing = [h for h in required if h not in found]
        errors.append(f'missing sections: {missing}' if missing else f'sections out of order: {found}')
    authors = [i for i, l in enumerate(lines) if AUTHOR.match(l.strip())]
    if len(authors) != 1:
        errors.append('need exactly one line "EVF-Author: anthropic" or "EVF-Author: openai"')
    elif headings and authors[0] < headings[-1][0]:
        errors.append('the EVF-Author line must come after the last section')
    last = headings[-1][0] if headings else 0
    machine = [i for i, l in enumerate(lines) if i > last and l.startswith('EVF-Author:')]
    ends = [i for i, _ in headings[1:]] + [machine[0] if machine else len(lines)]
    for (start, heading), end in zip(headings, ends):
        if heading in required and not ''.join(lines[start + 1:end]).strip():
            errors.append(f'section has no content: {heading}')
    for e in errors:
        print(f'FAIL: {e}')
    if not errors:
        print(f'PASS: {len(required)} required sections and the EVF-Author line.')
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
