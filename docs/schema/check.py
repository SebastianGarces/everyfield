#!/usr/bin/env python3
"""Check the documented schema graph and capability coverage; no database needed."""
import argparse
import json
import copy
import re
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
LIBRARY_TABLES = {'auth_user', 'auth_account', 'auth_session', 'auth_verification'}
CLOSED_VALUE_COLUMNS = {
    'mail': ['purpose'], 'notice': ['purpose'], 'effect': ['kind'],
    'operation': ['name', 'stop_reason'],
    'contact_outcome': ['contact_channel'],
    'person': ['source'], 'audit_event': ['action','kind'], 'job': ['kind'],
}
OWNER_COLUMNS = {'tenant_id', 'plant_id', 'organization_id', 'account_id', 'owner_id', 'author_id'}
OWNER_ROOTS = {'account', 'plant', 'organization'}
# Applied early-access migration and its runner use these exact physical keys.
PHYSICAL_KEY_EXCEPTIONS = {'early_access_attempt': (), 'schema_migration': ('name',)}


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def key_columns(key):
    return tuple(key['columns'])


def scope_exception_name(table, fk):
    return (f"{table}({', '.join(fk['columns'])}) -> "
            f"{fk['references']['table']}({', '.join(fk['references']['columns'])})")


def owner_columns(table):
    """Recognize tenant aliases from root FKs and unconditional (id, owner) keys."""
    if table['name'] in OWNER_ROOTS:
        return {'id'}
    if any(c['name'] == 'tenant_id' for c in table['columns']):
        return {'tenant_id'}
    owners = set()
    for fk in table['foreign_keys']:
        if fk['references']['table'] in {'tenant', 'plant', 'organization', 'account'}:
            owners.update(set(fk['columns']) & OWNER_COLUMNS)
    for key in table['unique_keys']:
        if not key.get('where') and len(key['columns']) == 2 and 'id' in key['columns']:
            owners.update(set(key['columns']) & OWNER_COLUMNS)
    return owners


def forced_null_columns(expression):
    """Recognize unconditional NULL predicates, including nested AND/OR forms.

    This is a bounded documentation lint, not a SQL evaluator. Conditional NULL
    shape checks stay legal; every OR branch must force NULL for this to reject it.
    """
    tokens = re.findall(r"'(?:''|[^'])*'|[a-zA-Z_][\w]*|\d+|\S", expression.lower())

    def scan(parts):
        while parts and parts[0] == '(' and parts[-1] == ')':
            depth = 0
            for i, token in enumerate(parts):
                depth += (token == '(') - (token == ')')
                if depth == 0:
                    break
            if i != len(parts) - 1:
                break
            parts = parts[1:-1]
        for operator in ['or', 'and']:
            depth, start, groups = 0, 0, []
            for i, token in enumerate(parts):
                depth += (token == '(') - (token == ')')
                if depth == 0 and token == operator:
                    groups.append(scan(parts[start:i]))
                    start = i + 1
            if groups:
                groups.append(scan(parts[start:]))
                return set.intersection(*groups) if operator == 'or' else set.union(*groups)
        text = ' '.join(parts)
        for pattern in [r'(\w+) is null', r'(\w+) is not distinct from null',
                        r'not \( (\w+) is not null \)', r'num_nonnulls \( (\w+) \) = 0']:
            match = re.fullmatch(pattern, text)
            if match:
                return {match[1]}
        return set()

    return scan(tokens)


def closed_values(checks, column):
    """Read a literal text IN set, rather than a prose placeholder CHECK."""
    for check in checks:
        match = re.search(r'\b' + re.escape(column) + r'\s+in\s*\(([^)]*)\)', check, re.I)
        if not match:
            continue
        body = match[1]
        literals = re.findall(r"'((?:''|[^'])*)'", body)
        if literals and not re.sub(r"'(?:''|[^'])*'|[\s,]", '', body):
            return {value.replace("''", "'") for value in literals}
    return set()


def validate_schema(schema, label, authority=False, documented_exceptions=None):
    """Validate the graph; the CLI also supplies README's exception names."""
    errors = []
    tables = schema['tables']
    by_name = {t['name']: t for t in tables}
    if len(by_name) != len(tables):
        errors.append(f'{label}: duplicate table name')
    domains = {d['id'] for d in schema.get('domains', [])}
    if authority and schema['database'] != 'PostgreSQL':
        errors.append(f'{label}: database must be PostgreSQL')
    if authority and len(domains) != len(schema['domains']):
        errors.append(f'{label}: duplicate domain ID')
    for table in tables:
        name = table['name']
        prefix = f'{label}.{name}'
        columns = {c['name']: c for c in table['columns']}
        if len(columns) != len(table['columns']):
            errors.append(f'{prefix}: duplicate column name')
        pk = table['primary_key']
        key_exception = authority and name in PHYSICAL_KEY_EXCEPTIONS
        if key_exception and tuple(pk) != PHYSICAL_KEY_EXCEPTIONS[name]:
            errors.append(f'{prefix}: primary key differs from applied early-access schema')
        if (not pk and not key_exception) or len(pk) != len(set(pk)):
            errors.append(f'{prefix}: empty or repeated primary key')
        keys = ([] if key_exception and not pk else [pk]) + [k['columns'] for k in table['unique_keys']]
        for key in keys:
            if not key or len(key) != len(set(key)):
                errors.append(f'{prefix}: empty or repeated key columns {key}')
            missing = sorted(set(key) - columns.keys())
            if missing:
                errors.append(f'{prefix}: key names missing columns {missing}')
        for column in pk:
            if column in columns and columns[column]['nullable']:
                errors.append(f'{prefix}: nullable PK column {column}')
        if authority:
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
            # The migration ledger and its backfill sibling (C102) are keyed by the applied name.
            ledger = name in ('schema_migration', 'schema_backfill')
            migration_key = (ledger and pk == ['name']
                             and columns.get('name', {}).get('type') == 'text')
            if ledger and not migration_key:
                errors.append(f'{prefix}: migration ledger needs its applied text primary key')
            if len(pk) == 1 and columns.get(pk[0], {}).get('type') != 'uuid' and not migration_key:
                errors.append(f'{prefix}: single-column PK must be UUID')
            json_columns = {c['name'] for c in table['columns'] if c['type'].lower() == 'jsonb'}
            if json_columns != table['jsonb_keys'].keys():
                errors.append(f'{prefix}: JSONB documentation does not match columns')
            if any(not keys for keys in table['jsonb_keys'].values()):
                errors.append(f'{prefix}: empty JSONB key documentation')
            fk_columns = {c for fk in table['foreign_keys'] for c in fk['columns']}
            for column in table['columns']:
                historical_request = name == 'lifecycle_witness' and column['name'] == 'request_id'
                if (not table['library_owned'] and column['type'] == 'uuid'
                        and column['name'].endswith('_id') and not column['name'].startswith('opaque_')
                        and column['name'] != 'requester_opaque_id' and not historical_request
                        and column['name'] not in pk and column['name'] not in fk_columns):
                    errors.append(f'{prefix}: UUID relation {column["name"]} has no FK')
            if 'tenant_id' in columns and columns['tenant_id']['nullable']:
                errors.append(f'{prefix}: tenant_id must be nonnull, including restricted global work')
            for check in table['checks']:
                for column in forced_null_columns(check) & columns.keys():
                    errors.append(f'{prefix}: CHECK forces column {column} to stay null')
            for column in CLOSED_VALUE_COLUMNS.get(name, []):
                if column in columns and not closed_values(table['checks'], column):
                    errors.append(f'{prefix}: closed-value column {column} lacks literal IN CHECK')
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
            if authority:
                child_owners, parent_owners = owner_columns(table), owner_columns(target)
                exception = fk.get('scope_exception', '').strip()
                exception_name = scope_exception_name(name, fk)
                if (exception and documented_exceptions is not None
                        and exception_name not in documented_exceptions):
                    errors.append(f'{prefix}: scope exception not named in README: {exception_name}')
                paired = any(left in child_owners and right in parent_owners
                             for left, right in zip(local, remote))
                # Root targets identify owners or actors, not same-owner child bodies.
                if (target_name not in OWNER_ROOTS and child_owners and parent_owners
                        and not paired and not exception):
                    errors.append(f'{prefix}: tenant-owned parent {target_name} lacks compound owner FK or named scope exception')
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


def validate_catalog_sets(schema, operations):
    """Literal operation sets follow the inventory; projections follow schema metadata."""
    operations = [o for o in operations if not o['id'].startswith('privateCare.')]
    expected = {
        ('audit_event','action'): set(re.findall(r'\b[a-z_]+\.[a-z_]+\b','\n'.join(line for line in (ROOT/'docs/architecture/audit.md').read_text().splitlines() if line.startswith('|'))))|{'note_correction'},
        ('effect', 'kind'): {o['id'] for o in operations if o['kind'] == 'command'},
    }
    tables = {t['name']: t for t in schema['tables']}
    errors = []
    for (name, column), values in expected.items():
        if name in tables and closed_values(tables[name]['checks'], column) != values:
            errors.append(f'authority.{name}: {column} IN CHECK differs from current operation catalog')
    return errors


def counts(tables):
    return (len(tables), sum(len(t['columns']) for t in tables),
            sum(len(t['foreign_keys']) for t in tables),
            sum(c['type'].lower() == 'jsonb' for t in tables for c in t['columns']))


def coverage(capability_files, features, schema):
    errors = []
    capabilities = [c for file in capability_files for c in file['capabilities']]
    capability_ids = [c['id'] for c in capabilities]
    if len(capability_ids) != len(set(capability_ids)):
        errors.append('duplicate capability IDs')
    # Catalog membership defines coverage; implementation progress lives in build-progress.json.
    active_ids = {f['id'] for f in features if f.get('active', True)}
    feature_ids = {f['id'] for f in features}
    covered_features = {f for c in capabilities for f in c['feature_ids']}
    persistent = {c['id'] for c in capabilities if c['persists']}
    deferred=set(schema.get('schema_deferred_capabilities', []))
    if deferred - persistent: errors.append('Deferred schema capability must name a persistent product capability')
    served = {c for t in schema['tables'] for c in t['capabilities']}
    missing_features = sorted(active_ids - covered_features)
    missing_capabilities = sorted(persistent - served - deferred)
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


def run(root, schema_path):
    schema = read(schema_path)
    files = sorted((root / 'docs/schema/capabilities').glob('*.json'))
    if len(files) != 3:
        raise ValueError(f'expected three capability files, found {len(files)}')
    capability_files = [read(path) for path in files]
    features = read(root / 'docs/catalog/features.json')
    readme = (root / 'docs/schema/README.md').read_text(encoding='utf-8')
    documented_exceptions = set(re.findall(r'^- `([^`]+ -> [^`]+)`: .+', readme, re.M))
    errors = validate_schema(schema, 'authority', True, documented_exceptions)
    errors.extend(validate_catalog_sets(schema, read(root / 'docs/catalog/operations.json')['operations']))
    errors.extend(validate_metadata(schema, read(root / 'docs/plan/dag.json'), capability_files))
    coverage_errors, coverage_lines = coverage(capability_files, features, schema)
    errors.extend(coverage_errors)
    for table in schema['tables']:
        if table['library_owned'] != (table['name'] in LIBRARY_TABLES):
            errors.append(f'{table["name"]}: incorrect library_owned designation')
    print('Authority              Tables Columns   FKs JSONB')
    row = counts(schema['tables'])
    print(f'Target                 {row[0]:6} {row[1]:7} {row[2]:5} {row[3]:5}')
    print('\nDomain                 Tables/Columns/FKs/JSONB')
    groups = defaultdict(list)
    for table in schema['tables']:
        groups[table['domain']].append(table)
    for domain, tables in sorted(groups.items()):
        print(f'{domain:22} ' + '/'.join(map(str, counts(tables))))
    print('\nCoverage')
    for line in coverage_lines:
        print(line)
    if errors:
        print('\nFAIL')
        for error in errors:
            print('- ' + error)
        return 1
    print('\nPASS: structural keys, references, ownership, closed sets, NULL guards, JSONB documentation and coverage; producer and Person metadata')
    return 0


def validate_metadata(schema, dag, capability_files):
    """INV-schema-authority: metadata must resolve to the adopted graph and actual packages."""
    errors = []
    packages = {p['id'] for p in dag['packages']}
    # Generated table metadata may name a retired package; it resolves to the package that took its scope.
    retired = {r['id']: r['scope_moved_to'] for r in dag.get('retired_packages', [])}

    def resolve(value):
        if isinstance(value, dict):
            return {k: resolve(v) for k, v in value.items()}
        if isinstance(value, list):
            items = [resolve(v) for v in value]
            return list(dict.fromkeys(items)) if all(isinstance(v, str) for v in items) else items
        return retired.get(value, value) if isinstance(value, str) else value
    schema = resolve(schema)
    caps = {c['id']: c for f in capability_files for c in f['capabilities']}
    old = schema['legacy_table_producers']
    by = {t['name']: t for t in schema['tables']}
    for table in schema['tables']:
        name = table['name']
        producers = set(table['producer_work_packages'])
        if not producers:
            errors.append(f'{name}: no producer package')
        if producers - packages:
            errors.append(f'{name}: unknown producer packages {sorted(producers - packages)}')
        inherited = {p for n in table['replaces'] for p in old.get(n, [])}
        if set(table['replaces']) - old.keys():
            errors.append(f'{name}: unknown previous table in replaces')
        if not inherited <= producers:
            errors.append(f'{name}: missing inherited producer packages')
        basis = table['producer_derivation']
        if 'adopted_subtypes' in basis:
            actual_subtypes = {t['name'] for t in schema['tables'] if any(f['references']['table'] == 'record' and 'id' in f['columns'] for f in t['foreign_keys'])}
            expected_producers = {'WP-004'} | {p for n in actual_subtypes for p in by[n]['producer_work_packages']}
            if set(basis['adopted_subtypes']) != actual_subtypes:
                errors.append(f'{name}: subtype producer basis differs from adopted graph')
        else:
            sources = basis['old_target_tables']
            if set(sources) - old.keys():
                errors.append(f'{name}: producer basis names unknown previous table')
            expected_producers = {p for n in sources for p in old.get(n, [])} | set(basis.get('additional_producers', []))
            if table['replaces'] and set(sources) != set(table['replaces']):
                errors.append(f'{name}: producer basis differs from replaced tables')
        if producers != expected_producers:
            errors.append(f'{name}: producer packages differ from recorded derivation')
        expected_features = {f for c in table['capabilities'] if c in caps for f in caps[c]['feature_ids']}
        if set(table['feature_ids']) != expected_features:
            errors.append(f'{name}: feature metadata differs from capabilities')
    declared = {(t['name'], tuple(f['columns']), tuple(f['references']['columns']))
                for t in schema['tables'] for f in t['foreign_keys'] if f['references']['table'] == 'person'}
    registered = [(r['table'], tuple(r['columns']), tuple(r['target_columns'])) for r in schema['person_references']]
    if declared != set(registered) or len(registered) != len(set(registered)):
        errors.append('Person reference registry differs from adopted Person FKs')
    for key, actual in [('table_count', len(by)), ('column_count', counts(schema['tables'])[1]), ('foreign_key_count', counts(schema['tables'])[2])]:
        if schema[key] != actual:
            errors.append(f'{key}: metadata differs from authority')
    person_sources = closed_values(by['person']['checks'], 'source')
    if not {'other', 'meeting_guest_list'} <= person_sources or any(set(schema['type_contracts'][key]) != person_sources for key in ['person_source', 'person.source', 'ApprovedRecruitmentSource']):
        errors.append('Person source CHECK differs from literal type contract or lacks required sources')
    for name, table in by.items():
        for column in table['columns']:
            values = closed_values(table['checks'], column['name'])
            if values and set(schema['type_contracts'].get(name + '.' + column['name'], [])) != values:
                errors.append(f'{name}.{column["name"]}: literal type contract differs from CHECK')
    return errors


def self_test(root):
    """INV-schema-authority: the public CLI must reject each required broken input."""
    schema = read(root / 'docs/schema/target.json')
    features = read(root / 'docs/catalog/features.json')
    capability_paths = sorted((root / 'docs/schema/capabilities').glob('*.json'))
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
        ('mixed-scope child without compound FK', 'tenant_fk', 1, 'tenant-owned parent document lacks compound owner FK'),
        ('INV-tenancy: mail Person FK without plant owner', 'plant_fk', 1, 'tenant-owned parent person lacks compound owner FK'),
        ('INV-tenancy: editor revision FK without organization owner', 'organization_fk', 1, 'tenant-owned parent article_revision lacks compound owner FK'),
        ('INV-tenancy: root avatar FK without account owner', 'root_fk', 1, 'authority.account: tenant-owned parent file_object lacks compound owner FK'),
        ('INV-tenancy: invented scope exception', 'undocumented_exception', 1, 'scope exception not named in README: mail(recipient_person_id) -> person(id)'),
        ('INV-tenancy: documented cross-owner source', 'documented_exception', 0, 'PASS: structural keys'),
        ('mixed-scope child without any parent FK', 'missing_parent', 1, 'UUID relation document_id has no FK'),
        ('nullable global owner bypass', 'nullable_tenant', 1, 'tenant_id must be nonnull'),
        ('unconditional NULL CHECK', 'null_check', 1, 'CHECK forces column body to stay null'),
        ('conjunctive NULL CHECK', 'null_and', 1, 'CHECK forces column body to stay null'),
        ('NULL in every alternative', 'null_or', 1, 'CHECK forces column body to stay null'),
        ('missing closed-value CHECK', 'closed', 1, 'closed-value column purpose lacks literal IN CHECK'),
        ('catalog drift', 'catalog', 1, 'action IN CHECK differs from current operation catalog'),
        ('missing producer', 'producer', 1, 'no producer package'),
        ('unknown producer', 'producer_unknown', 1, 'unknown producer packages'),
        ('missing inherited producer', 'producer_inherited', 1, 'missing inherited producer packages'),
        ('missing Person registration', 'person_registry', 1, 'Person reference registry differs'),
        ('Person source placeholder', 'person_source', 1, 'closed-value column source lacks literal IN CHECK'),
    ]
    with tempfile.TemporaryDirectory(prefix='evf-schema-check-') as directory:
        fixture = Path(directory)
        for folder in ['docs/schema', 'docs/catalog', 'docs/schema/capabilities', 'docs/plan']:
            (fixture / folder).mkdir(parents=True, exist_ok=True)
        (fixture / 'docs/plan/dag.json').write_text(json.dumps(read(root / 'docs/plan/dag.json')))
        (fixture / 'docs/catalog/features.json').write_text(json.dumps(features))
        (fixture / 'docs/catalog/operations.json').write_text(json.dumps(read(root / 'docs/catalog/operations.json')))
        for label, fault, status, expected in cases:
            candidate, cap_files = copy.deepcopy(schema), copy.deepcopy(capabilities)
            readme = (root / 'docs/schema/README.md').read_text(encoding='utf-8')
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
            elif fault == 'tenant_fk':
                entry = next(t for t in candidate['tables'] if t['name'] == 'document_revision')
                parent = next(f for f in entry['foreign_keys'] if f['references']['table'] == 'document')
                parent['columns'], parent['references']['columns'] = ['document_id'], ['id']
            elif fault in {'plant_fk', 'organization_fk', 'root_fk', 'undocumented_exception', 'documented_exception'}:
                table_name, column = {
                    'plant_fk': ('mail', 'recipient_person_id'),
                    'organization_fk': ('article_editor_state', 'draft_revision_id'),
                    'root_fk': ('account', 'avatar_object_id'),
                    'undocumented_exception': ('mail', 'recipient_person_id'),
                    'documented_exception': ('mail', 'recipient_person_id'),
                }[fault]
                table = next(t for t in candidate['tables'] if t['name'] == table_name)
                parent = next(f for f in table['foreign_keys'] if column in f['columns'])
                parent['columns'], parent['references']['columns'] = [column], ['id']
                if fault.endswith('exception'):
                    parent['scope_exception'] = 'Fixture cross-owner source requires explicit current entitlement.'
                    if fault == 'documented_exception':
                        readme += '\n- `' + scope_exception_name(table_name, parent) + '`: ' + parent['scope_exception'] + '\n'
                        registered = next(r for r in candidate['person_references'] if r['table'] == 'mail')
                        registered['columns'], registered['target_columns'] = [column], ['id']
            elif fault == 'missing_parent':
                entry = next(t for t in candidate['tables'] if t['name'] == 'document_revision')
                entry['foreign_keys'] = [f for f in entry['foreign_keys'] if f['references']['table'] != 'document']
            elif fault == 'nullable_tenant':
                entry = next(t for t in candidate['tables'] if t['name'] == 'document_revision')
                next(c for c in entry['columns'] if c['name'] == 'tenant_id')['nullable'] = True
            elif fault in {'null_check', 'null_and', 'null_or'}:
                conversation = next(t for t in candidate['tables'] if t['name'] == 'document_revision')
                conversation['checks'].append({
                    'null_check': '(body IS NULL)',
                    'null_and': '(body is null) and version_number >= 1',
                    'null_or': "(body is null and version_number = 1) or (version_number = 2 and body is null)",
                }[fault])
            elif fault == 'closed':
                mail = next(t for t in candidate['tables'] if t['name'] == 'mail')
                mail['checks'] = [c for c in mail['checks'] if not c.startswith('purpose in')]
            elif fault == 'catalog':
                operation=next(t for t in candidate['tables'] if t['name']=='audit_event')
                operation['checks']=["action in ('invented.command')" if c.startswith('action in') else c for c in operation['checks']]
            elif fault == 'producer':
                candidate['tables'][0]['producer_work_packages'] = []
            elif fault == 'producer_unknown':
                candidate['tables'][0]['producer_work_packages'].append('WP-999')
            elif fault == 'producer_inherited':
                candidate['tables'][0]['producer_work_packages'] = ['WP-004']
            elif fault == 'person_registry':
                candidate['person_references'].pop()
            elif fault == 'person_source':
                person = next(t for t in candidate['tables'] if t['name'] == 'person')
                person['checks'] = [c for c in person['checks'] if not c.startswith('source in')]
            (fixture / 'docs/schema/target.json').write_text(json.dumps(candidate))
            (fixture / 'docs/schema/README.md').write_text(readme)
            for path, content in zip(capability_paths, cap_files):
                (fixture / 'docs/schema/capabilities' / path.name).write_text(json.dumps(content))
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--root', str(fixture)],
                                    capture_output=True, text=True, cwd=directory, timeout=30)
            if result.returncode != status or expected not in result.stdout:
                print(f'FAIL: INV-schema-authority {label}: {result.returncode}\n{result.stdout}{result.stderr}')
                return 1
            print(f'PASS: INV-schema-authority {label}')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT, help='repository root; defaults to the script location')
    parser.add_argument('--schema', type=Path, help='alternate authority file for validation')
    parser.add_argument('--self-test', action='store_true', help='exercise CLI failure cases in temporary fixtures')
    args = parser.parse_args()
    try:
        if args.self_test:
            return self_test(args.root)
        return run(args.root, args.schema or args.root / 'docs/schema/target.json')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f'FAIL: invalid input: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
