#!/usr/bin/env python3
"""docs/reliability-checklist.json is a list of items that `bin/dev checklist` can match against a diff.

Each item has an `id`, a `trigger` (`paths`, a list of path globs, and/or `added`, a regex over added diff lines), a
one-sentence `check` and a `source` (the incident, task or PR it came from). Node and Python both read the regex, so it
may not use lookbehind, named groups or inline flags. `--self-test` proves a missing field and a regex that does not
compile each fail.
"""
from pathlib import Path
import json
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
CHECKLIST = 'docs/reliability-checklist.json'
FIELDS = ('id', 'trigger', 'check', 'source')


def problems(items):
    found = []
    for index, item in enumerate(items):
        name = item.get('id') or f'item {index}'
        found += [f'{name}: missing {field}' for field in FIELDS if not item.get(field)]
        added = (item.get('trigger') or {}).get('added')
        if added is not None:
            try:
                re.compile(added)
            except re.error as error:
                found.append(f'{name}: trigger added does not compile: {error}')
    return found


def self_test():
    good = {'id': 'demo', 'trigger': {'paths': ['a/**'], 'added': 'x+'}, 'check': 'Is it?', 'source': 'T-1'}
    no_source = {key: value for key, value in good.items() if key != 'source'}
    assert problems([good]) == [], problems([good])
    assert problems([no_source]) == ['demo: missing source'], problems([no_source])
    found = problems([{**good, 'trigger': {'added': '(unclosed'}}])
    assert len(found) == 1 and found[0].startswith('demo: trigger added does not compile'), found
    print('PASS: reliability checklist self-test')
    return 0


def main(argv):
    if argv == ['--self-test']:
        return self_test()
    found = problems(json.loads((ROOT / CHECKLIST).read_text()))
    for problem in found:
        print('FAIL: ' + problem)
    if found:
        return 1
    print(f'PASS: every {CHECKLIST} item has an id, a trigger that compiles, a check and a source')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
