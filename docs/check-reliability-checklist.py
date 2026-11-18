#!/usr/bin/env python3
"""docs/reliability-checklist.json is a list of items that `bin/dev checklist` can match against a diff.

Each item has a unique `id`, a `trigger`, a one-sentence `check` and a `source` (the incident, task or PR it came from).
A trigger holds `paths` (a non-empty list of path globs), `added` (a regex over added diff lines) or both. Node and
Python both read the regex, so it may not use lookbehind, named groups or inline flags. `--self-test` proves an item
missing a field, a regex that does not compile and a Python-only regex each fail.
"""
from pathlib import Path
import json
import re
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
CHECKLIST = 'docs/reliability-checklist.json'
FIELDS = ('id', 'trigger', 'check', 'source')
PORTABLE_GROUP = re.compile(r'\(\?(?![:=!])')


def text(value):
    return isinstance(value, str) and value.strip() != ''


def trigger_problems(trigger):
    if not isinstance(trigger, dict) or not trigger or set(trigger) - {'paths', 'added'}:
        return ['trigger must hold paths, added or both, and nothing else']
    found = []
    paths = trigger.get('paths')
    if 'paths' in trigger and (not isinstance(paths, list) or not paths or not all(map(text, paths))):
        found.append('trigger paths must be a non-empty list of globs')
    if 'added' in trigger:
        added = trigger['added']
        if not text(added):
            found.append('trigger added must be a non-empty regex')
        else:
            try:
                re.compile(added)
            except re.error as error:
                found.append(f'trigger added does not compile: {error}')
            else:
                if PORTABLE_GROUP.search(added):
                    found.append('trigger added uses lookbehind, a named group or an inline flag')
    return found


def problems(path):
    items = json.loads(path.read_text())
    if not isinstance(items, list):
        return [f'{CHECKLIST}: must be a list of items']
    found, seen = [], set()
    for index, item in enumerate(items):
        name = item.get('id') if isinstance(item, dict) and text(item.get('id')) else f'item {index}'
        if not isinstance(item, dict):
            found.append(f'{name}: must be an object')
            continue
        found += [f'{name}: missing {field}' for field in FIELDS if field not in item]
        found += [f'{name}: {field} must be a non-empty string'
                  for field in ('id', 'check', 'source') if field in item and not text(item[field])]
        if 'trigger' in item:
            found += [f'{name}: {problem}' for problem in trigger_problems(item['trigger'])]
        if name in seen:
            found.append(f'{name}: duplicate id')
        seen.add(name)
    return found


def self_test():
    good = {'id': 'demo', 'trigger': {'paths': ['a/**'], 'added': 'x+'}, 'check': 'Is it?', 'source': 'T-1'}
    cases = [
        ({}, []),
        ({'source': None}, ['demo: missing source']),
        ({'trigger': {'added': '(unclosed'}}, ['demo: trigger added does not compile']),
        ({'trigger': {'added': '(?<=a)b'}}, ['demo: trigger added uses lookbehind']),
        ({'trigger': {'paths': []}}, ['demo: trigger paths must be']),
        ({'trigger': {}}, ['demo: trigger must hold']),
        ({'check': ''}, ['demo: check must be']),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / 'checklist.json'
        for change, expected in cases:
            item = {key: value for key, value in {**good, **change}.items() if value is not None}
            path.write_text(json.dumps([item]))
            found = problems(path)
            assert len(found) == len(expected) and all(f.startswith(e) for f, e in zip(found, expected)), (change, found)
        path.write_text(json.dumps([good, good]))
        assert problems(path) == ['demo: duplicate id'], problems(path)
    print('PASS: reliability checklist self-test')
    return 0


def main(argv):
    if argv == ['--self-test']:
        return self_test()
    found = problems(ROOT / CHECKLIST)
    for problem in found:
        print('FAIL: ' + problem)
    if found:
        return 1
    print(f'PASS: every {CHECKLIST} item has an id, a trigger that compiles, a check and a source')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
