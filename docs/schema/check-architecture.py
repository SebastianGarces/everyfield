#!/usr/bin/env python3
"""Resolve architecture identifiers and closed inventories against target.json."""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def check(root):
    schema = json.loads((root / 'docs/schema/target.json').read_text())
    tables = {t['name']: t for t in schema['tables']}
    columns = {name: {c['name'] for c in t['columns']} for name, t in tables.items()}
    all_columns = set().union(*columns.values())
    retired = set(schema['legacy_table_producers']) - tables.keys()
    errors = []
    for path in sorted((root / 'docs/architecture').glob('*.md')):
        for line_no, line in enumerate(path.read_text().splitlines(), 1):
            for token in re.findall(r'`([^`]+)`', line):
                if re.fullmatch(r'[a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*', token):
                    table, column = token.split('.')
                    valid = table in columns and column in columns[table]
                else:
                    valid = token in tables or token in all_columns
                if not valid:
                    errors.append(f'{path.relative_to(root)}:{line_no}: unresolved identifier {token}')
            for token in re.findall(r'\b[a-z_][a-z_0-9]*\b', line):
                if token in retired:
                    errors.append(f'{path.relative_to(root)}:{line_no}: retired table {token}')
    execution = (root / 'docs/architecture/execution.md').read_text()
    kinds = set(re.findall(r'^\| ([a-z_]+) \|', execution, re.M)) - {'Kind'}
    if kinds != set(schema['type_contracts']['job.kind']):
        errors.append('execution handler inventory differs from job.kind')
    audit = (root / 'docs/architecture/audit.md').read_text()
    actions = set(re.findall(r'\b[a-z_]+\.[a-z_]+\b', '\n'.join(l for l in audit.splitlines() if l.startswith('|'))))
    if actions != set(schema['type_contracts']['event.action']):
        errors.append('audit action inventory differs from event.action')
    acceptance = json.loads((root / 'docs/acceptance/schema.json').read_text())
    for case in acceptance['cases']:
        for name in case.get('schema_tables', []):
            if name not in tables:
                errors.append(f'{case["id"]}: unresolved schema table {name}')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    errors = check(args.root)
    print('\n'.join('FAIL: ' + e for e in errors) if errors else
          'PASS: architecture identifiers, audit actions, job kinds and acceptance table bindings resolve')
    return bool(errors)


if __name__ == '__main__':
    raise SystemExit(main())
