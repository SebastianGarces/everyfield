#!/usr/bin/env python3
"""Check ADR-001 contract coverage and foundation/delivery boundaries, not runtime acceptance."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read(path):
    return json.loads((ROOT / path).read_text())


def calls(case):
    yield case['action']['operation']
    for child in case.get('subcases', []):
        yield from calls(child)


def check():
    catalog = read('docs/catalog/index.json')
    requirements = {r['id']: r for path in catalog['requirement_files']
                    for r in read(path)['requirements']}
    cases = {c['id']: c for path in catalog['case_files'] for c in read(path)['cases']}
    operations = {o['id']: o for o in read(catalog['operation_source'])['operations']}
    schema = read('docs/schema/target.json')
    tables = {t['name']: t for t in schema['tables']}
    dag = read('docs/plan/dag.json')
    packages = {p['id']: p for p in dag['packages']}
    slices = {s['id']: set(s['cumulative_packages']) for s in dag['vertical_slices']}
    expected_owners = ['WP-011', 'WP-006', 'WP-007', 'WP-008', 'WP-011', 'WP-009',
                       'WP-098', 'WP-098', 'WP-098', 'WP-099', 'WP-099', 'WP-099',
                       'WP-100', 'WP-100', 'WP-101', 'WP-007']
    owned_operations = set()
    exercised = set()
    for number, owner in enumerate(expected_owners, 1):
        fid = f'MUL-{number:03d}'
        requirement = requirements['REQ-' + fid]
        case = cases[f'ADR1-{number:03d}']
        assert owner in requirement['work_packages'], f'{fid}: wrong producer'
        assert owner in case['work_packages'], f'{fid}: case missing producer'
        assert 'WP-102' in case['work_packages'], f'{fid}: no integration owner'
        assert case['id'] in requirement['case_ids'], f'{fid}: unbound case'
        assert fid in case['feature_ids'], f'{fid}: unbound feature'
        assert 'REQ-' + fid in case['requirement_ids'], f'{fid}: wrong requirement'
        owned_operations.update(requirement['operations'])
        exercised.update(calls(case))
        if owner in slices['S0']:
            assert 'REQ-' + fid in packages[owner]['context_scope']['case_requirements_at_start']
    assert owned_operations <= exercised, 'ADR operation lacks a concrete case action'
    for oid in owned_operations:
        operation = operations[oid]
        assert operation['case_ids'], f'{oid}: no example'
        assert operation['durable_write'] == (operation['kind'] == 'command')
        if operation['model_tool'] and operation['durable_write']:
            assert operation['evry_review'], f'{oid}: durable tool bypasses exact review'
    protected = ['pipeline.readConversationNote', 'development.readFeedback',
                 'development.recordFeedback', 'pipeline.recordAssessmentOccurrence']
    assert all(not operations[oid]['model_tool'] for oid in protected)
    assert not any(oid.startswith(('commissioning.', 'partnership.', 'churchStages.'))
                   for oid in owned_operations), 'Deferred stage entered current inventory'
    assert all('WP-102' in packages[pid]['depends_on'] for pid in ['WP-056', 'WP-057'])
    assert not slices['S2'] & {'WP-098', 'WP-099', 'WP-100', 'WP-101', 'WP-102'}
    assert slices['S2'] < slices['S2M']
    assert {'WP-098', 'WP-099', 'WP-100', 'WP-101', 'WP-102'} <= slices['S2M']
    # Plant-only consumers keep their real plant FK while Person exposes its actual owner key.
    for table in tables.values():
        for fk in table['foreign_keys']:
            if fk['references']['table'] == 'person':
                assert fk['references']['columns'] == ['id', 'tenant_id']
                assert len(fk['columns']) == 2, table['name'] + ': ownerless Person reference'
    for column in ['tenant_id', 'plant_id', 'organization_id']:
        assert any(c['name'] == column for c in tables['person']['columns'])
    assert any('num_nonnulls(plant_id, organization_id) = 1' == c
               for c in tables['person']['checks'])
    assert any('organization_id is not null and stage is null' in c
               for c in tables['person']['checks'])
    assert not any(c['name'] in {'calling_score', 'assessment_result', 'readiness_rating'}
                   for t in tables.values() if t['name'].startswith(('pipeline_', 'development_'))
                   for c in t['columns'])
    assert {'share_foundations', 'share_milestones', 'consent_revision', 'ended_at'} <= {
        c['name'] for c in tables['residency_link']['columns']}
    assert {'columns': ['relationship_id']} in tables['pipeline_sharing']['unique_keys']
    assert {'relationship_id', 'network_id', 'share_pipeline_totals'} <= {
        c['name'] for c in tables['pipeline_sharing']['columns']}
    print('PASS: ADR-001 requirements, concrete operation cases, S0 ownership, Person keys, '
          'resident consent, protected model exclusions and before-alpha delivery are connected. '
          'Scope is documentation only; runtime and independent review remain required.')


if __name__ == '__main__':
    check()
