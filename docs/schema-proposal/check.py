#!/usr/bin/env python3
"""Check the documented schema graph and capability coverage; no database needed."""
import argparse
import json
import copy
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
LIBRARY_TABLES = {'auth_user', 'auth_account', 'auth_session', 'auth_verification'}
CURRENT_DOMAINS = {
    'identity': 'auth_user auth_account auth_session auth_verification auth_throttle app_account platform_grant',
    'tenancy': 'tenancy_membership access_invitation plant organization organization_network_link plant_affiliation organization_sharing_settings discovery_profile discovery_association association_invitation association_event account_person_link',
    'people': 'household person person_tag_definition person_tag person_skill person_4c_assessment person_interview person_commitment person_activity record_correction person_merge',
    'teams': 'ministry_team team_role team_membership team_responsibility training_program training_requirement_version training_assignment_episode training_assignment_event training_completion',
    'meetings': 'meeting_location meeting meeting_participation meeting_invitation meeting_rsvp_token vision_response meeting_evaluation meeting_checklist_item meeting_event',
    'tasks': 'recurrence_series follow_up_obligation task task_relation task_dependency task_status_event follow_up_outcome phase_template_offer_response template_import_receipt',
    'phases': 'phase_transition plant_attestation person_attestation',
    'launch': 'launch launch_event launch_milestone launch_milestone_task launch_person_attendance',
    'care': 'planter_checkin planter_checkin_event',
    'reference': 'reference_release reference_activation reference_section reference_chunk reference_template_version',
    'wiki': 'wiki_article wiki_source wiki_article_version organization_wiki_article_state plant_wiki_source_order plant_wiki_source_order_entry wiki_read_progress wiki_read_event wiki_bookmark wiki_article_feedback',
    'documents': 'owned_documents owned_document_revisions generated_document upload_intent object_metadata',
    'intelligence': 'assessment_demand intelligence_assessment_run intelligence_insight organization_intelligence_runs organization_intelligence_contributor organization_intelligence_assessments intelligence_feedback',
    'communication': 'message_template communication communication_recipient email_intent email_attempt provider_event_receipt communication_delivery_retry email_suppression notification_preference inbox_entry',
    'assistant': 'assistant_conversation assistant_message assistant_artifact assistant_attachment assistant_plan assistant_approval operation_execution operation_effect operation_result',
    'operations': 'product_feedback feedback_publication command_receipt job audit_event deletion_witness recovery_manifest',
}


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def key_columns(key):
    return tuple(key['columns'])


def validate_schema(schema, label, proposal=False):
    """Validate names, key arity/types and non-partial FK candidate keys."""
    errors = []
    tables = schema['tables']
    by_name = {t['name']: t for t in tables}
    if len(by_name) != len(tables):
        errors.append(f'{label}: duplicate table name')
    domains = {d['id'] for d in schema.get('domains', [])}
    if proposal and schema['database'] != 'PostgreSQL':
        errors.append(f'{label}: database must be PostgreSQL')
    if proposal and len(domains) != len(schema['domains']):
        errors.append(f'{label}: duplicate domain ID')
    for table in tables:
        name = table['name']
        prefix = f'{label}.{name}'
        columns = {c['name']: c for c in table['columns']}
        if len(columns) != len(table['columns']):
            errors.append(f'{prefix}: duplicate column name')
        pk = table['primary_key']
        if not pk or len(pk) != len(set(pk)):
            errors.append(f'{prefix}: empty or repeated primary key')
        for key in [pk] + [k['columns'] for k in table['unique_keys']]:
            if not key or len(key) != len(set(key)):
                errors.append(f'{prefix}: empty or repeated key columns {key}')
            missing = sorted(set(key) - columns.keys())
            if missing:
                errors.append(f'{prefix}: key names missing columns {missing}')
        for column in pk:
            if column in columns and columns[column]['nullable']:
                errors.append(f'{prefix}: nullable PK column {column}')
        if proposal:
            required = {'name', 'domain', 'purpose', 'library_owned', 'columns', 'primary_key',
                        'unique_keys', 'foreign_keys', 'checks', 'jsonb_keys', 'capabilities', 'replaces'}
            missing = required - table.keys()
            if missing:
                errors.append(f'{prefix}: missing fields {sorted(missing)}')
            if table['domain'] not in domains:
                errors.append(f'{prefix}: unknown domain {table["domain"]}')
            if not table['capabilities']:
                errors.append(f'{prefix}: table has no capability')
            for column in table['columns']:
                if not {'name', 'type', 'nullable', 'note'} <= column.keys():
                    errors.append(f'{prefix}: incomplete column definition {column.get("name")}')
                if not isinstance(column['nullable'], bool):
                    errors.append(f'{prefix}: nullable must be boolean')
            if len(pk) == 1 and columns.get(pk[0], {}).get('type') != 'uuid':
                errors.append(f'{prefix}: single-column PK must be UUID')
            json_columns = {c['name'] for c in table['columns'] if c['type'].lower() == 'jsonb'}
            if json_columns != table['jsonb_keys'].keys():
                errors.append(f'{prefix}: JSONB documentation does not match columns')
            if any(not keys for keys in table['jsonb_keys'].values()):
                errors.append(f'{prefix}: empty JSONB key documentation')
        for fk in table['foreign_keys']:
            target_name = fk['references']['table']
            local = fk['columns']
            remote = fk['references']['columns']
            missing_local = sorted(set(local) - columns.keys())
            if missing_local:
                errors.append(f'{prefix}: FK names missing local columns {missing_local}')
            if target_name not in by_name:
                errors.append(f'{prefix}: FK names missing table {target_name}')
                continue
            target = by_name[target_name]
            target_columns = {c['name']: c for c in target['columns']}
            missing_remote = sorted(set(remote) - target_columns.keys())
            if missing_remote:
                errors.append(f'{prefix}: FK names missing {target_name} columns {missing_remote}')
            if not local or len(local) != len(remote):
                errors.append(f'{prefix}: FK arity mismatch for {target_name}')
            candidates = {tuple(target['primary_key'])} | {
                key_columns(k) for k in target['unique_keys'] if not k.get('where')
            }
            if tuple(remote) not in candidates:
                errors.append(f'{prefix}: FK target {target_name}{remote} is not an unconditional key')
            for left, right in zip(local, remote):
                if left in columns and right in target_columns:
                    if columns[left]['type'].lower() != target_columns[right]['type'].lower():
                        errors.append(f'{prefix}: FK type mismatch {left} -> {target_name}.{right}')
    return errors


def counts(tables):
    return (len(tables), sum(len(t['columns']) for t in tables),
            sum(len(t['foreign_keys']) for t in tables),
            sum(c['type'].lower() == 'jsonb' for t in tables for c in t['columns']))


def coverage(capability_files, features, proposal):
    errors = []
    capabilities = [c for file in capability_files for c in file['capabilities']]
    capability_ids = [c['id'] for c in capabilities]
    if len(capability_ids) != len(set(capability_ids)):
        errors.append('duplicate capability IDs')
    # Catalog status tracks implementation, not whether a feature still counts.
    active_ids = {f['id'] for f in features if f.get('active', True)}
    feature_ids = {f['id'] for f in features}
    covered_features = {f for c in capabilities for f in c['feature_ids']}
    persistent = {c['id'] for c in capabilities if c['persists']}
    served = {c for t in proposal['tables'] for c in t['capabilities']}
    missing_features = sorted(active_ids - covered_features)
    missing_capabilities = sorted(persistent - served)
    unknown_features = sorted(covered_features - feature_ids)
    unknown_capabilities = sorted(served - set(capability_ids))
    if missing_features:
        errors.append(f'active features missing from capabilities: {missing_features}')
    if missing_capabilities:
        errors.append(f'persistent capabilities without a table: {missing_capabilities}')
    if unknown_features:
        errors.append(f'unknown feature IDs: {unknown_features}')
    if unknown_capabilities:
        errors.append(f'unknown table capability IDs: {unknown_capabilities}')
    return errors, [
        f'Active features covered: {len(active_ids & covered_features)}/{len(active_ids)}',
        f'Capabilities: {len(capabilities)} total; {len(persistent)} persistent; {len(capabilities) - len(persistent)} behavior-only',
        f'Persistent capabilities mapped: {len(persistent & served)}/{len(persistent)}',
        f'Missing active features: {missing_features}',
        f'Missing persistent capabilities: {missing_capabilities}',
        f'Unknown feature IDs: {unknown_features}',
        f'Unknown table capability IDs: {unknown_capabilities}',
    ]


def run(root, proposal_path):
    current = read(root / 'docs/schema/target.json')
    proposal = read(proposal_path)
    files = sorted((root / 'docs/schema-proposal/capabilities').glob('*.json'))
    if len(files) != 3:
        raise ValueError(f'expected three capability files, found {len(files)}')
    capability_files = [read(path) for path in files]
    features = read(root / 'docs/catalog/features.json')
    errors = validate_schema(current, 'current') + validate_schema(proposal, 'proposal', True)
    coverage_errors, coverage_lines = coverage(capability_files, features, proposal)
    errors.extend(coverage_errors)
    for table in proposal['tables']:
        unknown = set(table['replaces']) - {t['name'] for t in current['tables']}
        if unknown:
            errors.append(f'{table["name"]}: replaces unknown current tables {sorted(unknown)}')
        if table['library_owned'] != (table['name'] in LIBRARY_TABLES):
            errors.append(f'{table["name"]}: incorrect library_owned designation')
    current_domain = {}
    for domain, names in CURRENT_DOMAINS.items():
        for name in names.split():
            if name in current_domain:
                errors.append(f'current domain assignment repeated: {name}')
            current_domain[name] = domain
    current_names = {t['name'] for t in current['tables']}
    if current_names != current_domain.keys():
        errors.append(f'current domain mapping mismatch: missing {sorted(current_names - current_domain.keys())}; obsolete {sorted(current_domain.keys() - current_names)}')
    print('Schema                 Tables Columns   FKs JSONB')
    for label, schema in [('Current', current), ('Proposal', proposal)]:
        row = counts(schema['tables'])
        print(f'{label:22} {row[0]:6} {row[1]:7} {row[2]:5} {row[3]:5}')
    print('\nLibrary-owned subtotal Tables Columns   FKs JSONB')
    for label, schema in [('Current', current), ('Proposal', proposal)]:
        selected = [t for t in schema['tables'] if t['name'] in LIBRARY_TABLES] if label == 'Current' else [t for t in schema['tables'] if t['library_owned']]
        row = counts(selected)
        print(f'{label:22} {row[0]:6} {row[1]:7} {row[2]:5} {row[3]:5}')
    print('\nDomain                 Current T/C/F/J       Proposal T/C/F/J')
    old_groups, new_groups = defaultdict(list), defaultdict(list)
    for table in current['tables']:
        old_groups[current_domain.get(table['name'], 'unmapped')].append(table)
    for table in proposal['tables']:
        new_groups[table['domain']].append(table)
    for domain in sorted(old_groups.keys() | new_groups.keys()):
        old = '/'.join(map(str, counts(old_groups[domain])))
        new = '/'.join(map(str, counts(new_groups[domain])))
        print(f'{domain:22} {old:20} {new}')
    print('\nCoverage')
    for line in coverage_lines:
        print(line)
    for file in capability_files:
        active = {f['id'] for f in features if f['id'] in {fid for c in file['capabilities'] for fid in c['feature_ids']}}
        print(f'Group {file["group"]}: {len(file["capabilities"])} capabilities; {len(active)} feature IDs')
    if errors:
        print('\nFAIL')
        for error in errors:
            print('- ' + error)
        return 1
    print('\nPASS: structural keys, references, JSONB documentation and coverage')
    return 0


def self_test(root):
    """AC-schema-proposal: the public CLI must reject each required broken input."""
    schema = read(root / 'docs/schema-proposal/schema.json')
    current = read(root / 'docs/schema/target.json')
    features = read(root / 'docs/catalog/features.json')
    capability_paths = sorted((root / 'docs/schema-proposal/capabilities').glob('*.json'))
    capabilities = [read(path) for path in capability_paths]
    cases = [
        ('valid input', None, 0, 'PASS: structural keys'),
        ('missing FK table', 'fk_table', 1, 'FK names missing table nonexistent'),
        ('missing FK local column', 'fk_local', 1, 'FK names missing local columns'),
        ('missing FK remote column', 'fk_remote', 1, 'FK names missing auth_user columns'),
        ('missing PK column', 'pk', 1, 'key names missing columns'),
        ('missing unique column', 'unique', 1, 'key names missing columns'),
        ('unmapped persistent capability', 'capability', 1, 'persistent capabilities without a table'),
        ('missing active feature', 'feature', 1, 'active features missing from capabilities'),
    ]
    with tempfile.TemporaryDirectory(prefix='evf-schema-check-') as directory:
        fixture = Path(directory)
        for folder in ['docs/schema', 'docs/catalog', 'docs/schema-proposal/capabilities']:
            (fixture / folder).mkdir(parents=True, exist_ok=True)
        (fixture / 'docs/schema/target.json').write_text(json.dumps(current))
        (fixture / 'docs/catalog/features.json').write_text(json.dumps(features))
        for label, fault, status, expected in cases:
            candidate, cap_files = copy.deepcopy(schema), copy.deepcopy(capabilities)
            auth_account = next(t for t in candidate['tables'] if t['name'] == 'auth_account')
            fk = auth_account['foreign_keys'][0]
            if fault == 'fk_table':
                fk['references']['table'] = 'nonexistent'
            elif fault == 'fk_local':
                fk['columns'] = ['nonexistent']
            elif fault == 'fk_remote':
                fk['references']['columns'] = ['nonexistent']
            elif fault == 'pk':
                candidate['tables'][0]['primary_key'] = ['nonexistent']
            elif fault == 'unique':
                candidate['tables'][0]['unique_keys'].append({'columns': ['nonexistent']})
            elif fault == 'capability':
                for table in candidate['tables']:
                    table['capabilities'] = [c for c in table['capabilities'] if c != 'CAP-A-001']
            elif fault == 'feature':
                for file in cap_files:
                    for capability in file['capabilities']:
                        capability['feature_ids'] = [f for f in capability['feature_ids'] if f != 'IDN-001']
            (fixture / 'docs/schema-proposal/schema.json').write_text(json.dumps(candidate))
            for path, content in zip(capability_paths, cap_files):
                (fixture / 'docs/schema-proposal/capabilities' / path.name).write_text(json.dumps(content))
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--root', str(fixture)],
                                    capture_output=True, text=True, cwd=directory, timeout=30)
            if result.returncode != status or expected not in result.stdout:
                print(f'FAIL: AC-schema-proposal {label}: {result.returncode}\n{result.stdout}{result.stderr}')
                return 1
            print(f'PASS: AC-schema-proposal {label}')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT, help='repository root; defaults to the script location')
    parser.add_argument('--proposal', type=Path, help='alternate proposal file for validation')
    parser.add_argument('--self-test', action='store_true', help='exercise CLI failure cases in temporary fixtures')
    args = parser.parse_args()
    try:
        if args.self_test:
            return self_test(args.root)
        return run(args.root, args.proposal or args.root / 'docs/schema-proposal/schema.json')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f'FAIL: invalid input: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
