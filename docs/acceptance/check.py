#!/usr/bin/env python3
"""Read-only acceptance examples, linkage and behavioral consistency check."""
import argparse
from collections import defaultdict
import datetime
import json
from pathlib import Path
import sys
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def read(path):
    return json.loads(path.read_text())


def validate(value, schema, definitions, location):
    """Validate the JSON Schema vocabulary used by case.schema.json."""
    if '$ref' in schema:
        return validate(value, definitions[schema['$ref'].split('/')[-1]], definitions, location)
    errors = []
    types = {'object': lambda x: isinstance(x, dict), 'array': lambda x: isinstance(x, list),
             'string': lambda x: isinstance(x, str), 'null': lambda x: x is None,
             'boolean': lambda x: isinstance(x, bool),
             'number': lambda x: isinstance(x, (int, float)) and not isinstance(x, bool)}
    allowed = schema.get('type')
    if allowed and not any(types[t](value) for t in ([allowed] if isinstance(allowed, str) else allowed)):
        return [f'{location}: expected {allowed}']
    if 'enum' in schema and value not in schema['enum']:
        errors.append(f'{location}: invalid enum value')
    if 'anyOf' in schema and not any(not validate(value, choice, definitions, location) for choice in schema['anyOf']):
        errors.append(f'{location}: needs result or error_code')
    if isinstance(value, dict):
        for key in schema.get('required', []):
            if key not in value:
                errors.append(f'{location}: missing {key}')
        if len(value) < schema.get('minProperties', 0):
            errors.append(f'{location}: empty fixture or object')
        for key, item in value.items():
            child = schema.get('properties', {}).get(key)
            if child is None:
                child = schema.get('additionalProperties', {})
                if child is False:
                    errors.append(f'{location}: unexpected {key}')
                    continue
            errors.extend(validate(item, child, definitions, f'{location}.{key}'))
    if isinstance(value, list):
        if len(value) < schema.get('minItems', 0):
            errors.append(f'{location}: empty array')
        if schema.get('uniqueItems') and len({json.dumps(x, sort_keys=True) for x in value}) != len(value):
            errors.append(f'{location}: duplicate array item')
        for i, item in enumerate(value):
            errors.extend(validate(item, schema.get('items', {}), definitions, f'{location}[{i}]'))
    if isinstance(value, str):
        if len(value.strip()) < schema.get('minLength', 0):
            errors.append(f'{location}: empty string')
        if schema.get('format') == 'date-time':
            try:
                instant = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
                if not value.endswith('Z') or instant.tzinfo is None:
                    raise ValueError('UTC required')
            except ValueError:
                errors.append(f'{location}: expected UTC ISO instant ending Z')
    return errors


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def normalize(text):
    return ' '.join(text.split()).casefold()


def check(root):
    index = read(root / 'docs/catalog/index.json')
    schema = read(root / 'docs/acceptance/case.schema.json')
    requirements = {r['id']: r for file in index['requirement_files']
                    for r in read(root / file)['requirements']}
    bundles = read(root / index['acceptance_source'])
    operations = read(root / index['operation_source'])['operations']
    operation_ids = {o['id'] for o in operations}
    proof_actions = {'sql.inspectConstraints', 'sql.inspectEventRows',
                     'sql.inspectRuntimeGrants', 'build.inspectBrowserBundle',
                     'configuration.inspectProviderPrivacy',
                     'configuration.inspectMixedEnvironment'}
    forbidden = {normalize(r['text']) for r in requirements.values()}
    cases = {}
    inputs = {}
    groups = defaultdict(list)
    errors = []
    for file in index['case_files']:
        payload = read(root / file)
        if payload.get('case_schema') != 'docs/acceptance/case.schema.json':
            errors.append(f'{file}: missing current schema reference')
        for case in payload['cases']:
            label = f"{file}:{case.get('id', '<missing-id>')}"
            errors.extend(validate(case, schema, schema['$defs'], label))
            cid = case.get('id')
            if cid in cases:
                errors.append(f'{label}: duplicate case ID')
            cases[cid] = case
            own_text = normalize(case.get('requirement', ''))
            if case.get('group'):
                groups[case['group']].append(case)
            def expectations(example, name, parent_given=None):
                given = {**(parent_given or {}), **example.get('given', {})}
                signature = json.dumps([given, example.get('actor'), example.get('clock'),
                                        example.get('action')], sort_keys=True)
                expected = json.dumps(example.get('expected'), sort_keys=True)
                previous = inputs.get(signature)
                if previous and previous[1] != expected:
                    errors.append(f'{name}: identical inputs but different expected result from {previous[0]}')
                else:
                    inputs[signature] = (name, expected)
                operation = example.get('action', {}).get('operation')
                if operation not in operation_ids | proof_actions:
                    errors.append(f'{name}: unknown operation {operation}')
                # A nested scalar identity such as S1 can also be a terse catalog clause.
                # Prose, checks and a whole-string result cannot echo even a terse clause.
                if any((normalize(s) in forbidden or normalize(s) == own_text)
                       and (len(s.split()) >= 3 or s in example.get('expected', {}).get('checks', [])
                            or s == example.get('expected', {}).get('result'))
                       for s in strings(example.get('expected', {}))):
                    errors.append(f'{name}: expected repeats requirement text')
                try:
                    ZoneInfo(example['clock']['zone'])
                except (KeyError, ZoneInfoNotFoundError, ValueError):
                    errors.append(f'{name}: invalid clock zone')
                if '$fixture_ref' in json.dumps(example):
                    errors.append(f'{name}: unresolved fixture reference')
                names = [sub.get('name') for sub in example.get('subcases', [])]
                if len(set(names)) != len(names):
                    errors.append(f'{name}: duplicate subcase name')
                for sub in example.get('subcases', []):
                    expectations(sub, name + '/' + str(sub.get('name')), given)
            expectations(case, label)
    for group, members in groups.items():
        if all(c['id'].casefold().startswith(group.casefold() + '-') for c in members):
            errors.append(f'group {group}: group is only an ID prefix')
        group_operations = {c['action']['operation'] for c in members}
        if len(group_operations) != 1:
            errors.append(f'group {group}: mixed action operations')
        shapes = {json.dumps({key: row.get('fixture_type') for key, row in c['given'].items()},
                             sort_keys=True) for c in members}
        arguments = {tuple(sorted(c['action']['arguments'])) for c in members}
        if len(shapes) != 1 or len(arguments) != 1:
            errors.append(f'group {group}: mixed fixture or action shape')
    for kind, records in [('requirement', requirements.values()), ('acceptance', bundles), ('operation', operations)]:
        for record in records:
            for cid in record.get('case_ids', []):
                if cid not in cases:
                    errors.append(f"{kind} {record['id']}: unknown case {cid}")
    if index['counts']['future_cases'] != len(cases):
        errors.append('catalog case count differs from unique case IDs')
    registered = set(index['case_files'])
    actual = {str(p.relative_to(root)) for p in (root / 'docs/acceptance').glob('*.json')
              if 'cases' in read(p)}
    if actual != registered:
        errors.append('case files differ from catalog registration')
    return errors, cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    try:
        errors, cases = check(args.root)
    except (ValueError, KeyError, OSError) as error:
        print(f'FAIL: {error}', file=sys.stderr)
        return 1
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print(f'PASS: {len(cases)} unique acceptance examples match the case schema and reference graph; no requirement echoes.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
