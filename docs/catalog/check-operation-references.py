#!/usr/bin/env python3
"""Reject dangling operation IDs in catalog, plan and schema references."""
import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
OPERATION_ID = re.compile(r'[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*')


def references(value, location='$'):
    if isinstance(value, dict):
        for key, child in value.items():
            here = location + '.' + key
            if 'operation' in key:
                values = child if isinstance(child, list) else [child]
                for item in values:
                    if isinstance(item, str) and OPERATION_ID.fullmatch(item):
                        yield here, item
            yield from references(child, here)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from references(child, f'{location}[{index}]')


def check(root):
    inventory = root / 'docs/catalog/operations.json'
    ids = {op['id'] for op in json.loads(inventory.read_text())['operations']}
    errors = []
    # Case action/result labels include synthetic inspection helpers, not inventory IDs.
    paths = [path for folder in ['docs/catalog', 'docs/plan', 'docs/schema']
             for path in (root / folder).rglob('*.json')]
    for path in sorted(paths):
        for location, operation in references(json.loads(path.read_text())):
            if operation not in ids:
                errors.append(f'{path.relative_to(root)}:{location}: unknown operation {operation}')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    errors = check(args.root)
    print('\n'.join('FAIL: ' + error for error in errors) if errors else
          'PASS: documentation operation references resolve against operations.json')
    return bool(errors)


if __name__ == '__main__':
    raise SystemExit(main())
