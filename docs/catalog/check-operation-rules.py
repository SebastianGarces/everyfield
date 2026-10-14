#!/usr/bin/env python3
"""Audit the inventory reduction against its pre-fix Git revision.

Run with --report <outside-repository path> for every removed field's disposition.
The baseline stays in Git, rather than retaining a second operation catalog.
"""
import argparse
import collections
import json
from pathlib import Path
import re
import subprocess

BASE = '3885782ebd1402f85d8ec17df8f4f1b2e9ad6146'
ROOT = Path(__file__).resolve().parents[2]
INVENTORY_KEYS = {'id', 'purpose', 'feature_ids', 'owning_package', 'evry_packages',
                  'kind', 'authority', 'changes', 'durable_write', 'evry_review',
                  'evry', 'model_tool', 'privacy_exclusion', 'case_ids'}
SHAPE_KEYS = {'version', 'domain', 'acceptance_ids', 'ownership', 'surface_class',
              'requirement_ids', 'ownership_override_rule', 'model_tool_dispatch',
              'input_closed', 'reject_unrecognized_fields', 'delegates_to',
              'compatibility_rule'}
TOP_SHAPES = {'schema_version', 'status', 'authority', 'field_sets',
              'unmapped_source_target_aliases', 'surface_counts', 'model_tool_names',
              'named_domain_operation_count', 'applied_current_overlays',
              'reviewed_override_ids', 'runtime_semantic_audit', 'ownership_resolution',
              'exposure_counts', 'removed_redundant_product_operations',
              'checklist_canonical_aliases'}
TYPE_KEYS = {'type', 'fields', 'projected_fields', 'result_projection', 'closed',
             'required_parameters', 'additional_parameters', 'mode', 'storage',
             'operation', 'kind', 'source', 'status', 'authority', 'forbidden_input_fields'}


def load_base(path, base=BASE):
    return json.loads(subprocess.check_output(['git', '-C', str(ROOT), 'show', base + ':' + path]))


def canonicalizer(aliases, operations):
    mapping = {a['alias']: a['canonical_operation'] for a in aliases['aliases']
               if a['alias'] != a['canonical_operation']}
    mapping.update(operations.get('checklist_canonical_aliases', {}))
    pattern = re.compile(r'(?<![\w.])(?:' + '|'.join(re.escape(x) for x in sorted(mapping, key=len, reverse=True)) + r')(?![\w.])')
    def replace(text):
        for _ in range(3):
            text = pattern.sub(lambda m: mapping[m[0]], text)
        return text
    return replace, pattern


def align(text):
    # Physical identifiers follow Fix 2; ordinary revision/worker fences remain valid.
    text = text.replace('authorizationRevision', 'current authority').replace('authorization_revision', 'current authority')
    text = text.replace('authFence', 'current authority').replace('auth_fence', 'current authority')
    return text


TRANSACTION_PREFIX = 'One short caller-owned domain transaction rechecks exact current authority/subject/revisions, writes current state, attributable domain history, synchronous material revision, command receipt/audit and required intents; provider/model outside transaction. '


def behavior_text(text):
    # This repeated mechanism is already specified once in core.md.
    return text.removeprefix(TRANSACTION_PREFIX)


def parameter_rule(text):
    # Preserve qualifications in prose while retiring the named input types.
    match = re.fullmatch(r'[A-Z][\w|→]+ \((.*)\)', text)
    if match:
        return match[1][0].upper() + match[1][1:] + '.'
    return {
        'AuthenticatedSelfAccountId for account; exact current authorized plant/organization ID otherwise':
            'Account context uses authenticated self; other contexts require the exact currently authorized plant or organization.',
        'OwnAccountPerson scalar, not arbitrary internal account link':
            'Return only the own-account Person link, never an arbitrary internal account link.',
    }.get(text, text)


def narrative(value, path=''):
    """Keep domain restrictions, not a copied parameter/result schema."""
    if isinstance(value, dict):
        for key, child in value.items():
            if key in TYPE_KEYS:
                continue
            yield from narrative(child, path + '.' + key)
    elif isinstance(value, list):
        if value and all(isinstance(x, str) for x in value):
            # Allow/deny lists are behavior; ordinary DTO field layout is not.
            if any(k in path.lower() for k in ['forbidden', 'remove', 'allow', 'exclude', 'signalkey']):
                yield path.rsplit('.', 1)[-1].replace('_', ' ') + ': ' + ', '.join(value) + '.'
            else:
                for child in value:
                    yield from narrative(child, path)
        else:
            for child in value:
                yield from narrative(child, path)
    elif isinstance(value, str):
        if len(value.split()) >= 4:
            # A semicolon after a type introduces a behavioral qualification.
            if re.match(r'^[A-Z]\w*(?:\[.*?\])?(?:\|null)?;', value):
                value = value.split(';', 1)[1].strip()
            yield value
        elif '|' in value and not re.search(r'[A-Z]|null|boolean|string', value):
            yield 'Supported ' + path.rsplit('.', 1)[-1] + ' values: ' + value.replace('|', ', ') + '.'
    elif isinstance(value, bool) and any(k in path for k in ['exposed', 'permission', 'private_care', 'zero_substitution', 'summarized']):
        yield path.rsplit('.', 1)[-1].replace('_', ' ') + ': ' + str(value).lower() + '.'


def removed_fields(before, aliases):
    replace, _ = canonicalizer(aliases, before)
    atomicities = collections.Counter(o['atomicity'] for o in before['operations'])
    for op in before['operations']:
        for key, value in op.items():
            if key in ['id', 'feature_ids', 'case_ids', 'kind', 'model_tool', 'entry_points']:
                continue
            if key == 'authority':
                # Actor/scope stays in inventory. Actor-specific visibility belongs to requirements.
                rules = []
                for a in value:
                    if a['fields'] not in [op['result'].get('fields', [])] or 'member' in a['actor']:
                        rules.append('Visible information for ' + a['actor'] + ': ' + ', '.join(a['fields']) + '.')
                    if not a['purpose'].startswith(('Current authorized ', 'native operational work')):
                        rules.extend(narrative(a['purpose']))
                yield op, key, value, [align(replace(x)) for x in rules], 'actor/scope retained; signature shape is builder choice'
            elif key in SHAPE_KEYS or key in ['purpose', 'parameters', 'result']:
                rules = [parameter_rule(x) for x in narrative(value)] if key == 'parameters' else []
                yield op, key, value, [align(replace(x)) for x in rules], 'signature, layout or duplicate metadata is builder choice'
            elif key == 'review':
                rules = []
                if not value['scope'].startswith(('Exact ', 'exact ')):
                    rules.append(value['scope'])
                if value['before_execution'].startswith('Verify current lifecycle'):
                    rules.append(value['before_execution'])
                yield op, key, value, [align(replace(x)) for x in rules], 'review flag retained; shared review boundary in core.md; profile mechanics are builder choice'
            elif key in ['errors', 'error_contract', 'parameter_common', 'input_contract']:
                yield op, key, value, [], 'shared boundary/review/error rules in docs/architecture/core.md; exact types and profile are builder choice'
            elif key == 'atomicity' and atomicities[value] >= 19:
                yield op, key, value, [], 'shared transaction/read/private-protocol rules in docs/architecture/core.md; mechanics are builder choice'
            else:
                yield op, key, value, [align(replace(behavior_text(x))) for x in narrative(value, key)], 'domain behavior retained; exact encoding is builder choice'
    for key, value in before.items():
        if key == 'operations':
            continue
        rules = [] if key in TOP_SHAPES else [align(replace(x)) for x in narrative(value, key)]
        yield None, key, value, rules, 'shared catalog behavior retained; catalog bookkeeping and type layout are builder choice'
    for alias in aliases['aliases']:
        # Adaptation schemas disappear, but their extra predicates cannot disappear with them.
        for key, value in alias.items():
            rules = list(narrative(value, key)) if key in ['canonical_input_validation', 'current_authority_rule', 'context_projection', 'canonical_parameters', 'default_context_rule'] else []
            if key == 'result_transform' and value != 'Return exact canonical result below under current purpose projection; no generic QueryPage or CommandReceipt substitution.':
                rules = list(narrative(value, key))
            if key == 'equivalence' and isinstance(value, str) and ('does not' in value or 'never' in value):
                rules = list(narrative(value, key))
            if key == 'canonical_parameters':
                rules = [parameter_rule(x) for x in rules]
            yield {'id': alias['canonical_operation']}, 'alias.' + alias['alias'] + '.' + key, value, [align(replace(parameter_rule(x))) for x in rules], 'canonical reference replaces alias; adaptation types/transforms are builder choice'


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


def audit(base, report):
    before = load_base('docs/catalog/operations.json', base)
    aliases = load_base('docs/catalog/current-operation-aliases.json', base)
    catalog = json.loads((ROOT / 'docs/catalog/index.json').read_text())
    files = catalog['requirement_files'] + catalog['case_files']
    texts = {p: '\n'.join(strings(json.loads((ROOT / p).read_text()))) for p in files}
    texts.update({str(p.relative_to(ROOT)): p.read_text() for p in (ROOT / 'docs/architecture').glob('*.md')})
    core = texts['docs/architecture/core.md']
    for shared_rule in ['Meaningful domain changes recheck live authority',
                        'Failure of any required write rolls everything back.',
                        'Exact replay returns the original receipt without repeating effects.',
                        'Every durable Evry change requires review of exact effects',
                        'A changed review-sensitive fact supersedes approval.',
                        'Denials reveal no forbidden record existence.',
                        'truthful retry eligibility',
                        'Actor-private Evry conversation',
                        'Authorized pure reads have no durable domain effects']:
        assert shared_rule in core, 'Shared rule missing: ' + shared_rule
    rows = []
    missing = []
    for op, field, value, rules, choice in removed_fields(before, aliases):
        locations = []
        for rule in rules:
            targets = [p for p, text in texts.items() if rule in text]
            if not targets:
                missing.append((op['id'] if op else 'catalog', field, rule))
            locations.append({'rule': rule, 'locations': targets})
        rows.append({'operation': op['id'] if op else None, 'removed_field': field, 'source_value': value,
                     'disposition': choice, 'behavior': locations})
    inventory = json.loads((ROOT / catalog['operation_source']).read_text())['operations']
    assert {o['id'] for o in inventory} == {o['id'] for o in before['operations']}, 'Operation lost'
    assert all(set(o) == INVENTORY_KEYS for o in inventory), 'Unexpected inventory contract field'
    by_id = {o['id']: o for o in before['operations']}
    replace, _ = canonicalizer(aliases, before)
    for op in inventory:
        original = by_id[op['id']]
        for key in ['feature_ids', 'case_ids', 'kind']:
            assert op[key] == original[key], 'Changed ' + key + ' for ' + op['id']
        assert op['owning_package'] == original['ownership']['producer_work_package'], 'Changed producer'
        assert op['evry_packages'] == original['ownership']['evry_work_packages'], 'Changed adapter scope'
        assert op['model_tool'] == bool(original['model_tool']), 'Changed model availability'
        assert op['evry'] == ('evry' in original['entry_points']), 'Changed Evry availability'
        assert op['durable_write'] == (original['kind'] == 'command'), 'Changed durable-write classification'
        assert op['evry_review'] == (op['durable_write'] and op['evry'] and original['review']['required']), 'Changed review rule'
        actors = {(actor, rule['rule']) for rule in op['authority'] for actor in rule['actors']}
        assert actors == {(rule['actor'], align(replace(rule['scope']))) for rule in original['authority']}, 'Changed caller authority'
    assert next(o for o in inventory if o['id'] == 'emailSuppression.requestRestore')['owning_package'] == 'WP-028'
    assert not (ROOT / 'docs/catalog/current-operation-aliases.json').exists(), 'Alias file survives'
    _, pattern = canonicalizer(aliases, before)
    for p in list((ROOT / 'docs/product').glob('*.md')) + list((ROOT / 'docs/catalog/requirements').glob('*.json')):
        assert not pattern.search(p.read_text()), 'Alias remains in ' + str(p)
    if report:
        report.write_text(json.dumps({'base': base, 'fields': rows, 'missing': missing}, indent=2) + '\n')
    if missing:
        raise SystemExit('Missing behavior rules: ' + json.dumps(missing[:8]))
    print(f'PASS: {len(rows)} removed fields classified; {sum(len(r["behavior"]) for r in rows)} behavior rules located; all {len(inventory)} operations and canonical references retained.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default=BASE)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    audit(args.base, args.report)
