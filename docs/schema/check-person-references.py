#!/usr/bin/env python3
"""Compare the Person registry with declared FKs and frozen schema references."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def check(root):
    schema = json.loads((root / 'docs/schema/target.json').read_text())
    registry = json.loads((root / 'docs/architecture/person-references.json').read_text())
    tables = {t['name']: t for t in schema['tables']}
    declared = {(t['name'], tuple(f['columns']), tuple(f['references']['columns']))
                for t in tables.values() for f in t['foreign_keys']
                if f['references']['table'] == 'person'}
    errors = []
    for source, refs in [('schema', schema['person_references']),
                         ('architecture', registry['person_references'])]:
        entries = [(r['table'], tuple(r['columns']), tuple(r['target_columns'])) for r in refs]
        if len(entries) != len(set(entries)) or set(entries) != declared:
            errors.append(f'{source} Person registry differs from declared Person FKs')
    for key in ['person_references', 'person_snapshot_references']:
        if registry[key] != schema[key]:
            errors.append(f'architecture {key} differs from schema, including policies/producers')
    seen = set()
    for ref in schema['person_snapshot_references']:
        name, field = ref['table'], ref['field']
        identity = (name, field)
        if identity in seen:
            errors.append(f'duplicate snapshot reference {identity}')
        seen.add(identity)
        columns = {c['name'] for c in tables.get(name, {}).get('columns', [])}
        if not ref.get('policy') or any(c not in columns for c in field.split('/')):
            errors.append(f'unresolved frozen/generic Person reference {name}.{field}')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    errors = check(args.root)
    print('\n'.join('FAIL: ' + e for e in errors) if errors else
          'PASS: Person registry exactly matches declared FKs, frozen references and schema policies')
    return bool(errors)


if __name__ == '__main__':
    raise SystemExit(main())
