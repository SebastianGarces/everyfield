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


def check_case_facts(cases, tables):
    """Subcases overlay fixtures, never run after the parent's action."""
    revision_subjects = {
        'orgPeople.update': 'person', 'orgPeople.retire': 'person',
        'orgPeople.restore': 'person', 'orgPeople.remove': 'person',
        'residency.respondInvitation': 'invitation', 'pipeline.moveStage': 'person',
        'pipeline.recordAssessmentOccurrence': 'person',
        'development.publishVersion': 'program', 'development.applyVersion': 'enrollment',
        'development.updateEnrollment': 'enrollment',
        'development.completeMilestone': 'enrollment',
        'development.confirmMilestone': 'enrollment',
        'development.recordFeedback': 'enrollment',
        'development.recordUnlinkedCompletion': 'enrollment',
        'orgPeople.updateNote': 'note', 'orgPeople.removeNote': 'note',
    }
    input_references = {'person', 'program', 'version', 'based_on', 'enrollment', 'milestone',
                        'invitation', 'link', 'reading', 'director', 'stage', 'source',
                        'survivor', 'merge', 'network', 'relationship', 'staff_account'}
    problems = []
    checked = 0
    for case in cases.values():
        if not case['id'].startswith('ADR1-'):
            continue
        for example in [case, *case.get('subcases', [])]:
            given = {**case['given'], **example['given']}
            name = case['id'] + '/' + example.get('name', 'main')
            links = [r for r in given.values() if r['fixture_type'] == 'residency_link']
            for link in links:
                if link.get('ended_at') is not None and (link.get('share_foundations')
                                                        or link.get('share_milestones')):
                    problems.append(name + ': ended resident link still shares progress')
            if example['expected'].get('error_code'):
                continue
            checked += 1
            operation = example['action']['operation']
            arguments = example['action']['arguments']
            identities = {r.get('id', label): r for label, r in given.items()}
            for key in input_references & arguments.keys():
                value = arguments[key]
                if isinstance(value, str) and value not in given and value not in identities:
                    problems.append(name + ': input references missing fixture ' + key + '=' + value)
            for row_label, row in given.items():
                table = tables.get(row['fixture_type'])
                if not table:
                    continue
                for fk in table['foreign_keys']:
                    target = fk['references']['table']
                    # record is the subtype registry; tenant is represented by its actual root row.
                    if target == 'record' or not all(c in row for c in fk['columns']):
                        continue
                    values = [row[c] for c in fk['columns']]
                    if any(v is None for v in values):
                        continue
                    target_columns = fk['references']['columns']
                    candidates = [(label, candidate) for label, candidate in given.items()
                                  if candidate['fixture_type'] == target or target == 'tenant'
                                  and candidate['fixture_type'] in {'account', 'plant', 'organization'}]
                    if not any([candidate.get(c, label if c == 'id' else None)
                                for c in target_columns] == values for label, candidate in candidates):
                        problems.append(name + ': unresolved ' + row_label + '.'
                                        + '/'.join(fk['columns']) + ' -> ' + target)
            if 'expected_revisions' in arguments:
                for label, revision in arguments['expected_revisions'].items():
                    if given[label]['revision'] != revision:
                        problems.append(name + ': successful write has stale revision for ' + label)
            subject = revision_subjects.get(operation)
            if subject and 'expected_revision' in arguments:
                label = arguments[subject]
                if label in given and given[label].get('revision') != arguments['expected_revision']:
                    problems.append(name + ': successful write has stale revision for ' + label)
            if 'expected_consent_revision' in arguments:
                link = given[arguments['link']]
                if link['consent_revision'] != arguments['expected_consent_revision']:
                    problems.append(name + ': successful write has stale consent revision')
            if operation == 'development.recordUnlinkedCompletion':
                enrollment = given[arguments['enrollment']]
                if any(link.get('ended_at') is None
                       and link['person_id'] == enrollment['person_id']
                       and link['organization_id'] == enrollment['organization_id'] for link in links):
                    problems.append(name + ': director recording requires an unlinked enrollee')
            if operation == 'residency.respondInvitation':
                invitation = given[arguments['invitation']]
                if invitation.get('resident_person_id') != arguments['person']:
                    problems.append(name + ': invitation does not bind the exact Person')
                if arguments['decision'] == 'accept':
                    result = example['expected']['result']
                    creates = result.get('links_created', result.get('accepted_links', 0))
                    if creates and any(link.get('ended_at') is None
                                       and link['organization_id'] == invitation['tenant_id']
                                       and (link['person_id'] == arguments['person']
                                            or link['account_id'] == example['actor']['account'])
                                       for link in links):
                        problems.append(name + ': first acceptance collides with an active resident link')
    assert not problems, '\n'.join(problems)
    print(f'PASS: {checked} ADR success examples resolve explicit input/FK facts and revisions; '
          'first acceptance and ended-link fixtures respect resident-link constraints.')


def check():
    catalog = read('docs/catalog/index.json')
    requirements = {r['id']: r for path in catalog['requirement_files']
                    for r in read(path)['requirements']}
    cases = {c['id']: c for path in catalog['case_files'] for c in read(path)['cases']}
    operations = {o['id']: o for o in read(catalog['operation_source'])['operations']}
    schema = read('docs/schema/target.json')
    tables = {t['name']: t for t in schema['tables']}
    check_case_facts(cases, tables)
    dag = read('docs/plan/dag.json')
    packages = {p['id']: p for p in dag['packages']}
    slices = {s['id']: set(s['cumulative_packages']) for s in dag['vertical_slices']}
    expected_owners = ['WP-011', 'WP-006', 'WP-007', 'WP-008', 'WP-011', 'WP-009',
                       'WP-098', 'WP-098', 'WP-098', 'WP-099', 'WP-099', 'WP-099',
                       'WP-100', 'WP-100', 'WP-101', 'WP-007', 'WP-015']
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
    protected = ['pipeline.readConversationNote', 'pipeline.logConversation', 'pipeline.moveStage',
                 'orgPeople.readNotes', 'orgPeople.addNote', 'orgPeople.updateNote',
                 'orgPeople.removeNote', 'development.recordUnlinkedCompletion', 'development.readFeedback',
                 'development.recordFeedback', 'pipeline.recordAssessmentOccurrence']
    assert all(not operations[oid]['model_tool'] for oid in protected)
    assert operations['pipeline.proposeStageMove']['kind'] == 'query'
    assert operations['pipeline.proposeStageMove']['model_tool']
    assert all(operations[oid]['owning_package'] == 'WP-015' for oid in
               ['orgPeople.findDuplicates', 'orgPeople.merge', 'orgPeople.unmerge'])
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
    # PostgreSQL deparses the same checks with outer parentheses and uppercase keywords.
    assert any('num_nonnulls(plant_id, organization_id) = 1' == c.strip('() ')
               for c in tables['person']['checks'])
    assert any('organization_id is not null and stage is null' in c.lower().replace('(', '').replace(')', '')
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
