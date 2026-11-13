#!/usr/bin/env python3
"""Reject dangling operation IDs in catalog, plan and schema references, and malformed
operation implementation records."""
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


IMPLEMENTATION_STATUSES = {'not_built', 'hand_written'}


def implementation_errors(root, operation):
    """An optional implementation record says how an operation is built today (D-646)."""
    if 'implementation' not in operation:
        return []
    record, op_id = operation['implementation'], operation['id']
    if not isinstance(record, dict):
        return [f'{op_id}: implementation must be an object']
    errors = []
    status = record.get('status')
    if status not in IMPLEMENTATION_STATUSES:
        errors.append(f'{op_id}: implementation status {status!r} must be not_built or hand_written')
    note = record.get('note')
    if not isinstance(note, str) or not note.strip():
        errors.append(f'{op_id}: implementation needs a non-empty note')
    paths = record.get('paths')
    if status == 'not_built' and 'paths' in record:
        errors.append(f'{op_id}: not_built implementation takes no paths')
    if status == 'hand_written':
        if not isinstance(paths, list) or not paths:
            errors.append(f'{op_id}: hand_written implementation needs a non-empty paths list')
        else:
            for path in paths:
                inside = isinstance(path, str) and path and not Path(path).is_absolute() and \
                    (root / path).resolve().is_relative_to(root.resolve())
                if not inside or not (root / path).is_file():
                    errors.append(f'{op_id}: implementation path {path!r} does not exist')
    return errors


def check(root):
    inventory = root / 'docs/catalog/operations.json'
    operations = json.loads(inventory.read_text())['operations']
    ids = {op['id'] for op in operations}
    errors = [error for op in operations for error in implementation_errors(root, op)]
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
          'PASS: documentation operation references resolve against operations.json; '
          'implementation records are well formed')
    return bool(errors)


if __name__ == '__main__':
    raise SystemExit(main())
