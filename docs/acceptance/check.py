#!/usr/bin/env python3
"""Read-only acceptance examples, linkage and behavioral consistency check."""
import argparse
from collections import defaultdict
import datetime
import json
from pathlib import Path
import re
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


def normalize(text):
    return ' '.join(text.split()).casefold()


def repeats_requirement(value, own_texts, forbidden, field=None):
    if isinstance(value, str):
        text = normalize(value)
        # Terse legacy clauses also name literal versions and semantic error codes.
        # Those typed fields remain observations; prose/other fields get no exemption.
        literal_code = field in {'selected_version', 'error_code'} and len(value.split()) < 3
        return ((text in own_texts and not literal_code)
                or (text in forbidden and len(value.split()) >= 3))
    if isinstance(value, dict):
        return any(repeats_requirement(v, own_texts, forbidden, k) for k, v in value.items())
    if isinstance(value, list):
        return any(repeats_requirement(v, own_texts, forbidden, field) for v in value)
    return False


def closed_vocabularies(target):
    """Derive column vocabularies from the schema CHECKs and type contracts."""
    vocabularies = {}
    contracts = target['type_contracts']
    for table in target['tables']:
        for check in table.get('checks', []):
            for column, literals in re.findall(r"\b(\w+)\s+in\s*\(([^()]+)\)", check, re.I):
                if re.fullmatch(r"\s*'[^']*'(?:\s*,\s*'[^']*')*\s*", literals):
                    vocabularies[table['name'], column] = re.findall(r"'([^']*)'", literals)
        for column in table['columns']:
            values = contracts.get(table['name'] + '.' + column['name'],
                                   contracts.get(column['type']))
            if isinstance(values, list):
                vocabularies[table['name'], column['name']] = list(values)
            key = table['name'], column['name']
            if key in vocabularies and column['nullable']:
                vocabularies[key].append(None)
    return vocabularies


def vocabulary_errors(value, fixtures, vocabularies, location, table=None):
    """Check typed fixtures and expected rows, including inherited subcase rows."""
    errors = []
    if isinstance(value, dict):
        table = value.get('fixture_type', table)
        for key, item in value.items():
            column_table, column = key.rsplit('.', 1) if '.' in key else (table, key)
            allowed = vocabularies.get((column_table, column))
            if allowed and (item is not None or None not in allowed):
                if not isinstance(item, (str, int, float, bool)) or str(item).casefold() not in {
                        str(option).casefold() for option in allowed}:
                    errors.append(f'{location}.{key}: invalid {column_table}.{column} value '
                                  f'{item!r}; allowed {allowed}')
            child_table = fixtures.get(key)
            if child_table is None and isinstance(item, list) and key.endswith('s'):
                child_table = key[:-1]
            errors.extend(vocabulary_errors(item, fixtures, vocabularies, f'{location}.{key}',
                                            child_table))
    elif isinstance(value, list):
        for i, item in enumerate(value):
            errors.extend(vocabulary_errors(item, fixtures, vocabularies, f'{location}[{i}]', table))
    return errors



PROOF_ACTIONS = {'sql.inspectConstraints', 'sql.inspectEventRows', 'sql.inspectRuntimeGrants',
                 'build.inspectBrowserBundle', 'configuration.inspectProviderPrivacy',
                 'configuration.inspectMixedEnvironment'}
SETUP_TYPES = {'domain_inputs', 'behavior_inputs', 'example', 'fixture', 'test_setup'}
HARNESS_KEYS = {'fault', 'fault_control', 'recording_fault_control', 'foreign_control',
                'invalid_control', 'repeat', 'concurrent', 'concurrent_requests',
                'concurrent_accepts', 'concurrent_registrations', 'provider_response',
                'provider_responses', 'provider_accepted', 'current_generation',
                'old_generation', 'current_source_revision', 'expected_answer', 'expected', 'result'}
REFERENCE_FIELDS = {'invitation', 'proof', 'discovery', 'organization', 'person', 'personId',
                    'account', 'plant', 'tenant', 'meeting', 'task', 'intent', 'occurrence',
                    'object', 'upload', 'generation', 'candidate', 'snapshot', 'current_manifest',
                    'request', 'seat', 'feedback', 'proposal', 'report', 'preview', 'job', 'article'}


def leaves(value):
    if isinstance(value, dict):
        for child in value.values():
            yield from leaves(child)
    elif isinstance(value, list):
        for child in value:
            yield from leaves(child)
    else:
        yield value


def runnable_errors(case, example, given, operations, requirement, name):
    """Check case semantics without prescribing an implementation signature.

    These checks reject known impossible examples. Independent review still establishes
    that a chosen operation, fixtures and all scenario portions prove the requirement.
    """
    errors = []
    action = example.get('action', {})
    oid = action.get('operation')
    args = action.get('arguments', {})
    expected = example.get('expected', {})
    if oid in PROOF_ACTIONS:
        # Inspections belong only to declared platform-proof layers, not domain examples.
        layer = oid.split('.')[0]
        if layer not in case.get('layers', []):
            return [f'{name}: proof inspection requires its {layer} layer']
        return errors
    operation = operations.get(oid)
    if not operation:
        return [f'{name}: action must name an inventory operation or registered proof inspection']
    for key in HARNESS_KEYS & args.keys():
        errors.append(f'{name}: {key} is test setup, not an operation input')
    for key in args:
        if key.startswith('expected_') and key not in {
                'expected_revision', 'expected_revisions', 'expected_activation',
                'expected_relationship_revision', 'expected_consent_revision', 'expected_post_revision'}:
            errors.append(f'{name}: expected answer {key} cannot be an operation input')
    for label, fixture in given.items():
        typ = fixture.get('fixture_type', '')
        values = {k: v for k, v in fixture.items() if k != 'fixture_type'}
        if values and (typ in SETUP_TYPES or typ.endswith('_fixture')) and all(
                k in args and args[k] == v for k, v in values.items()):
            errors.append(f'{name}: arguments copy scenario fixture {label}')
    if 'fixture_type' in args:
        errors.append(f'{name}: arguments contain a fixture wrapper')
    for key in REFERENCE_FIELDS & args.keys():
        value = args[key]
        if isinstance(value, str) and value not in given:
            # Raw UUIDs/URLs and literal environment selectors are boundary inputs.
            if key in {'report', 'proposal', 'snapshot', 'current_manifest', 'preview'} or re.fullmatch(
                    r'(?:[A-Za-z]+[0-9]+|[A-Z][A-Za-z]*|[a-z]+-[A-Za-z0-9-]+)', value):
                errors.append(f'{name}: {key} references undefined fixture {value}')
    if case['id'].startswith('TARGET-') and args.get('person') == 'Alex' and 'subject' in args and not oid.startswith('people.'):
        errors.append(f'{name}: generic TARGET Person template does not exercise {oid}')
    if operation['kind'] == 'query':
        result = expected.get('result', {})
        inputs = list(leaves(args))
        informative = [v for v in leaves(result) if v is not None and not isinstance(v, bool)
                       and (not isinstance(v, (int, float)) or v not in [0, 1])
                       and (not isinstance(v, str) or len(v) > 3)]
        if informative and all(any(type(v) is type(i) and v == i for i in inputs) for v in informative):
            errors.append(f'{name}: query expected answer is already supplied in arguments')
        for label, changes in expected.get('state', {}).items():
            if isinstance(changes, dict) and label in given and any(
                    k in given[label] and v != given[label][k] for k, v in changes.items()):
                errors.append(f'{name}: read operation cannot change fixture {label}')
        if isinstance(result, dict) and any(isinstance(v, (int, float)) and not isinstance(v, bool)
                and v > 0 and re.search(r'(?:writes|inserted|new_effects|receipts)$', k)
                for k, v in result.items()):
            errors.append(f'{name}: read operation cannot produce write effects')
        if case['id'].startswith('TARGET-') and not case.get('subcases') and any(
                operations.get(o, {}).get('kind') == 'command' for o in requirement.get('operations', [])):
            errors.append(f'{name}: TARGET write scenarios need a command action or explicit command subcases')
    return errors

def check(root, package=None):
    index = read(root / 'docs/catalog/index.json')
    schema = read(root / 'docs/acceptance/case.schema.json')
    vocabularies = closed_vocabularies(read(root / 'docs/schema/target.json'))
    requirements = {r['id']: r for file in index['requirement_files']
                    for r in read(root / file)['requirements']}
    bundles = read(root / index['acceptance_source'])
    operations = read(root / index['operation_source'])['operations']
    operation_ids = {o['id'] for o in operations}
    operation_by = {o['id']: o for o in operations}
    dag = read(root / 'docs/plan/dag.json')
    s0 = set(next(s['required_packages'] for s in dag['vertical_slices'] if s['id'] == 'S0'))
    if package and package not in {p['id'] for p in dag['packages']}:
        raise ValueError('Unknown package: ' + package)
    later = defaultdict(set)
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
            requirement = case.get('requirement', '')
            own_texts = {normalize(requirement),
                         normalize(requirements.get(requirement, {}).get('text', requirement))}
            if case.get('group'):
                groups[case['group']].append(case)
            def expectations(example, name, parent_given=None):
                given = {**(parent_given or {}), **example.get('given', {})}
                fixtures = {key: row.get('fixture_type') for key, row in given.items()}
                for field in ('given', 'expected'):
                    errors.extend(vocabulary_errors(example.get(field, {}), fixtures, vocabularies,
                                                    name + '.' + field))
                signature = json.dumps([given, example.get('actor'), example.get('clock'),
                                        example.get('action')], sort_keys=True)
                expected = json.dumps(example.get('expected'), sort_keys=True)
                previous = inputs.get(signature)
                if previous and previous[1] != expected:
                    errors.append(f'{name}: identical inputs but different expected result from {previous[0]}')
                else:
                    inputs[signature] = (name, expected)
                operation = example.get('action', {}).get('operation')
                if operation not in operation_ids | PROOF_ACTIONS:
                    errors.append(f'{name}: unknown operation {operation}')
                problems = runnable_errors(case, example, given, operation_by,
                                           requirements.get(requirement, {}), name)
                if s0.intersection(case.get('work_packages', [])) or package in case.get('work_packages', []):
                    errors.extend(problems)
                elif problems:
                    later[cid].update(problems)
                if repeats_requirement(example.get('expected', {}), own_texts, forbidden):
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
    print(f'Runnable cases: {len(later)} later-package cases still need repair ({sum(map(len, later.values()))} findings).')
    if package:
        print(f'Closure check: every owned {package} case must be runnable.')
    return errors, cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--package', help='Fail on runnable-case defects for this package at closure')
    args = parser.parse_args()
    try:
        errors, cases = check(args.root, args.package)
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
