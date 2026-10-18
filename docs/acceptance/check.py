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
                 'configuration.inspectMixedEnvironment', 'build.inspectTargetCatalog'}
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


def expects_refusal(expected):
    """Only an explicit refused operation bypasses positive actor authority."""
    denied = {'access_denied', 'forbidden', 'unauthorized', 'not_found',
              'foreign_context_refused', 'current_authority_refused', 'unauthenticated'}
    result = expected.get('result', {})
    return (expected.get('error_code') in denied or
            isinstance(result, dict) and result.get('error_code') in denied)



def authority_errors(example, given, operations, name):
    actor = example.get('actor', {})
    account, context = actor.get('account'), actor.get('context')
    held = {'anonymous_public', 'public_or_sealed_expiring_proof',
            'public_or_verified_invitation_context'}
    authenticated = (account in given and actor.get('session') in given and
                     given[actor['session']].get('account') == account)
    if authenticated:
        held |= {'authenticated_self', 'authenticated_conversation_owner',
                 'authenticated_reference_reader',
                 'ambient_self_session_or_absent_invalid_cookie'}
    else:
        held |= {'anonymous_public', 'ambient_self_session_or_absent_invalid_cookie'}
    if account and actor.get('session') and context is None:
        held.add('authenticated_own_preplant_or_discovery_account')
    for row in given.values():
        if (row.get('fixture_type') == 'seat' and row.get('account') == account
                and row.get('tenant') == context and row.get('active') is True):
            kind = given.get(context, {}).get('fixture_type', 'plant')
            prefix = 'organization' if kind in {'organization', 'sending_church', 'network'} else 'plant'
            role = str(row.get('role', '')).lower()
            held.add(prefix + '_' + role)
            if prefix == 'plant' and role in {'owner', 'admin'}:
                if role == 'owner':
                    held.add('current_plant_owner_onboarding_subject')
                if any(r.get('original_author_account_id', r.get('originalAuthorAccountId')) == account
                       for r in given.values()):
                    held.add('original_author_current_plant_owner_or_admin')
    # Special principals/proofs are explicit harness fixtures. A plant session cannot
    # elevate itself by supplying one; operator/internal execution has no user session.
    for row in given.values():
        if row.get('account') != account or not account or not actor.get('session'):
            continue
        typ = row.get('fixture_type')
        if typ == 'registration_proof':
            held |= {'verified_own_pending_domain_account', 'verified_own_pending_or_active_account'}
        if typ == 'invitation_proof' and row.get('verified') is True:
            held.add('verified_addressed_invitee_without_active_seat')
        if typ == 'deletion_subject_proof' and row.get('verified') is True:
            held.add('verified_restricted_deletion_subject')
        if typ == 'discovery':
            held.add('authenticated_discovery_subject_owner')
    grants = [r for r in given.values() if r.get('fixture_type') == 'operation_capability'
              and r.get('verified') is True and r.get('principal')
              and r.get('actor') == actor]
    errors = []
    calls = [(example.get('action', {}), example.get('expected', {}))]
    execution = example.get('given', {}).get('execution', {})
    for field in ['parallel_calls', 'additional_calls']:
        for call in execution.get(field, []):
            calls.append((call, call.get('expected', {})))
    for call, expected in calls:
        oid = call.get('operation')
        if call.get('actor', actor) != actor:
            errors.extend(authority_errors({'actor': call['actor'], 'action': call,
                                            'expected': expected}, given, operations, name))
            continue
        operation = operations.get(oid)
        if not operation:
            continue
        refusal = expects_refusal(expected)
        # A query returning a negative policy decision still needs an authorized
        # caller. That decision is evidence, not refusal to invoke the query.
        query_refused = (expected.get('error_code') or
                         (expected.get('result', {}).get('error_code')
                          if isinstance(expected.get('result'), dict) else None))
        if refusal and (operation['kind'] != 'query' or query_refused):
            continue
        allowed = {token for rule in operation.get('authority', [])
                   for entry in rule['actors'] for token in entry.split('|')}
        exact = {g['authority'] for g in grants if oid in g.get('operation_ids', [])
                 and ((not account and not actor.get('session') and context is None) or
                      (authenticated and g['authority'] in {
                          'verified_restricted_deletion_subject', 'verified_addressed_invitee_without_active_seat',
                          'verified_own_pending_domain_account', 'verified_own_pending_or_active_account',
                          'verified_disable_only_proof', 'verified_one_hour_undo_proof',
                          'sealed_unexpired_rsvp_proof'}) or
                      (authenticated and g['authority'] == 'authenticated_internal_native_caller'
                       and any(h.startswith('plant_') for h in held)))}
        if allowed and not (held | exact) & allowed:
            errors.append(f'{name}: actor lacks authority for {oid}; requires {sorted(allowed)}')
    return errors


def owned_requirement_gaps(requirements, cases, package_ids):
    """Coverage is an owned case explicitly linked to this requirement."""
    return {pid: sorted(r['id'] for r in requirements.values()
                        if pid in r.get('work_packages', []) and not any(
                            pid in c.get('work_packages', []) and
                            (c['id'] in r.get('case_ids', []) or
                             r['id'] in [c.get('requirement')] + c.get('requirement_ids', []))
                            for c in cases.values())) for pid in package_ids}


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

def check(root, package=None, report=None):
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
    expected_count = 0
    for file in index['case_files']:
        payload = read(root / file)
        expected_count += len(payload['cases'])
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
                problems = authority_errors(example, given, operation_by, name)
                problems += runnable_errors(case, example, given, operation_by,
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
    if expected_count != len(cases):
        errors.append('fixture case count differs from unique case IDs')
    registered = set(index['case_files'])
    actual = {str(p.relative_to(root)) for p in (root / 'docs/acceptance').glob('*.json')
              if 'cases' in read(p)}
    if actual != registered:
        errors.append('case files differ from catalog registration')
    gaps = owned_requirement_gaps(requirements, cases, [p['id'] for p in dag['packages']])
    for pid, missing in gaps.items():
        print(f'Owned requirement coverage {pid}: {len(missing)} without an owned case' +
              (': ' + ', '.join(missing) if missing else '.'))
        declared = set(next(p for p in dag['packages'] if p['id'] == pid).get(
            'context_scope', {}).get('case_requirements_at_start', []))
        if pid in s0 and pid != package:
            errors.extend(f'{pid}/{rid}: owned requirement has no owned case or reviewed at-start assignment'
                          for rid in missing if rid not in declared)
        if pid == package:
            errors.extend(f'{pid}/{rid}: owned requirement has no owned case' for rid in missing)
    print(f'Runnable cases: {len(later)} later-package cases still need repair ({sum(map(len, later.values()))} findings).')
    if report:
        report.write_text(json.dumps({'owned_requirements_without_cases': gaps,
                                     'later_case_findings': {cid: sorted(v) for cid, v in sorted(later.items())},
                                     'errors': errors}, indent=2) + '\n')
    if package:
        print(f'Closure check: every owned {package} case must be runnable.')
    return errors, cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--package', help='Fail on runnable-case defects for this package at closure')
    parser.add_argument('--report', type=Path, help='Write detailed findings and coverage for every package')
    args = parser.parse_args()
    try:
        errors, cases = check(args.root, args.package, args.report)
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
