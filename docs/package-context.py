#!/usr/bin/env python3
"""Generate short package briefs, on-demand details and checked planning projections."""
import argparse
from functools import cache
import json
import math
import re
import sys
from pathlib import Path


def read(root, path):
    return json.loads((root / path).read_text())


def encode(value):
    return json.dumps(value, indent=2, ensure_ascii=False) + '\n'


ACCEPTANCE_DEFAULTS = {
    'required_test_layers': ['domain/contract', 'PostgreSQL integration where writes/concurrency',
                             'browser/tool evaluation where surfaced'],
    'evidence_status': 'future-not-run',
}


def load_acceptance(root, path='docs/catalog/acceptance.json'):
    return [dict(ACCEPTANCE_DEFAULTS, **bundle) for bundle in read(root, path)]


def load_schema(root):
    schema = read(root, 'docs/schema/target.json')['tables']
    packages = {p['id'] for p in read(root, 'docs/plan/dag.json')['packages']}
    for table in schema:
        producers = set(table['producer_work_packages'])
        if not producers or not producers <= packages:
            raise ValueError('Schema table ' + table['name'] + ' must name actual producer packages')
    return schema


def selected_features(scope, pid, features):
    mode = scope['features']
    if mode == 'all':
        return {f['id'] for f in features}
    if mode == 'owned':
        return {f['id'] for f in features if pid in f['work_packages']}
    if mode == 'prefixes':
        return {f['id'] for f in features if any(f['id'].startswith(x) for x in scope['feature_prefixes'])}
    if mode == 'explicit':
        ids = set(scope['feature_ids'])
        if not ids <= {f['id'] for f in features}:
            raise ValueError('Unknown feature selector for ' + pid)
        return ids
    raise ValueError('Unknown feature selection ' + mode)


def compile_manifest(root):
    dag = read(root, 'docs/plan/dag.json')
    ancestry = package_ancestry(dag)
    catalog = read(root, 'docs/catalog/index.json')
    features = read(root, catalog['feature_source'])
    acceptance = load_acceptance(root, catalog['acceptance_source'])
    operations = read(root, catalog['operation_source'])['operations']
    schema = load_schema(root)
    reqs = {x['id']: {'path': path, 'record': x}
            for path in catalog['requirement_files'] for x in read(root, path)['requirements']}
    cases = {x['id']: {'path': path, 'record': x}
             for path in catalog['case_files'] for x in read(root, path)['cases']}
    op_by = {o['id']: o for o in operations}
    shared_registry = read(root, 'docs/catalog/shared-contracts.json')['contracts']
    result = []
    for p in dag['packages']:
        pid, scope = p['id'], p['context_scope']
        fs = selected_features(scope, pid, features)
        # Catalog ownership is independent of the records needed for reading/proof.
        own_ops = {o['id'] for o in operations if pid == o['owning_package'] or pid in o['evry_packages']}
        own_rs = {rid for rid, v in reqs.items() if pid in v['record'].get('work_packages', [])}
        own_cs = {cid for cid, v in cases.items() if pid in v['record'].get('work_packages', [])}
        op_mode = scope['operations']
        if op_mode == 'explicit':
            ops = set(scope['operation_ids'])
        elif op_mode == 'evry_owned':
            ops = {o['id'] for o in operations if pid in o['evry_packages']}
        elif op_mode in ['features', 'owned_and_features']:
            ops = {o['id'] for o in operations if fs & set(o['feature_ids'])}
        elif op_mode == 'owned':
            ops = set()
        else:
            raise ValueError('Unknown operation selection ' + op_mode)
        ops |= own_ops
        if not ops <= op_by.keys():
            raise ValueError('Unknown operation selector for ' + pid)
        req_mode = scope['requirements']
        if req_mode == 'explicit':
            rs = set(scope['requirement_ids'])
        elif req_mode in ['features', 'owned_and_features', 'features_and_operations']:
            rs = {rid for rid, v in reqs.items() if fs & set(v['record']['feature_ids']) or
                  (req_mode == 'features_and_operations' and ops & set(v['record'].get('operations', [])))}
        elif req_mode == 'owned':
            rs = set()
        else:
            raise ValueError('Unknown requirement selection ' + req_mode)
        rs = (rs - set(scope.get('exclude_requirement_ids', []))) | own_rs
        if not rs <= reqs.keys():
            raise ValueError('Unknown requirement selector for ' + pid)
        ac_mode = scope.get('acceptance', 'owned_and_features')
        acs = set(scope['acceptance_ids']) if ac_mode == 'explicit' else {
            a['id'] for a in acceptance if a['feature_id'] in fs or
            (ac_mode == 'owned_and_features' and pid in a['work_packages'])}
        acs |= set(scope.get('acceptance_ids', []))
        if not acs <= {a['id'] for a in acceptance}:
            raise ValueError('Unknown acceptance selector for ' + pid)
        consumed_ac_rs = {rid for a in acceptance if a['id'] in acs for rid in a['requirement_ids']} - own_rs
        consumed_ac_ops = {oid for a in acceptance if a['id'] in acs for oid in a['operations']} - own_ops
        rs |= consumed_ac_rs
        queue = list(rs)
        while queue:
            rid = queue.pop()
            for shared in reqs[rid]['record'].get('shared_contract_ids', []):
                if shared in reqs and shared not in rs:
                    rs.add(shared)
                    queue.append(shared)
        shared_symbols = set(scope.get('shared_contract_ids', [])) | {
            shared for rid in rs for shared in reqs[rid]['record'].get('shared_contract_ids', []) if shared not in reqs}
        if not shared_symbols <= shared_registry.keys():
            raise ValueError('Unresolved shared contract ' + str(shared_symbols - shared_registry.keys()))
        ops |= consumed_ac_ops
        unresolved = []
        for rid in rs:
            for operation in reqs[rid]['record'].get('operations', []):
                if operation not in op_by:
                    unresolved.append({'requirement': rid, 'operation': operation})
                else:
                    ops.add(operation)
        case_mode = scope['cases']
        if case_mode == 'explicit':
            cs = set(scope['case_ids'])
        elif case_mode in ['features', 'owned_and_features', 'operations_and_features']:
            cs = {cid for cid, v in cases.items() if fs & set(v['record']['feature_ids'])}
            cs |= {cid for o in operations if o['id'] in own_ops for cid in o['case_ids'] if cid in cases}
        elif case_mode == 'owned':
            cs = set()
        else:
            raise ValueError('Unknown case selection ' + case_mode)
        cs |= own_cs | set(scope.get('case_ids', [])) | {cid for a in acceptance if a['id'] in acs for cid in a['case_ids']}
        if case_mode not in ['explicit', 'owned']:
            cs |= {cid for rid in rs for cid in reqs[rid]['record'].get('case_ids', []) if cid in cases}
        if not cs <= cases.keys():
            raise ValueError('Unknown case selector for ' + pid)
        context_cs = {cid for cid in cs if not any(
            owner == pid or owner in ancestry(pid) or pid in ancestry(owner)
            for owner in cases[cid]['record']['work_packages'])}
        cs -= context_cs
        tables = {t['name'] for t in schema if scope['schema'] != 'none' and pid in t['producer_work_packages']}
        result.append(dict(
            id=pid, feature_ids=sorted(fs), own_requirement_ids=sorted(own_rs), own_case_ids=sorted(own_cs),
            own_operation_ids=sorted(own_ops),
            case_requirements_at_start=sorted(scope.get('case_requirements_at_start', [])), requirement_ids=sorted(rs), shared_requirement_ids=sorted(rs - own_rs),
            consumed_acceptance_requirement_ids=sorted(consumed_ac_rs), consumed_acceptance_operation_ids=sorted(consumed_ac_ops),
            acceptance_ids=sorted(acs), case_ids=sorted(cs), context_case_ids=sorted(context_cs), operation_ids=sorted(ops), shared_operation_ids=sorted(ops - own_ops),
            shared_contract_ids=sorted(shared_symbols), unresolved_current_operation_references=unresolved,
            direct_prerequisites=p['depends_on'], ui_prerequisites=p.get('ui_depends_on', []),
            producer_table_names=sorted(tables), consumer_table_names=sorted(
                t['name'] for t in schema if (scope['schema'] == 'all' or fs & set(t['feature_ids'])) and t['name'] not in tables),
            proof_stage=scope['proof_stage'],
            contract_consumption_rule='Selected context does not change feature ownership or authorized access.'))
    return dict(
        version=4, scope='Catalog fields own work; DAG selectors add consumed context only.',
        catalog_source='docs/catalog/index.json', package_source='docs/plan/dag.json',
        requirement_locations={k: v['path'] for k, v in sorted(reqs.items())},
        case_locations={k: v['path'] for k, v in sorted(cases.items())},
        shared_read_paths=['AGENTS.md', 'docs/START-HERE.md', 'docs/architecture/core.md',
                           'docs/architecture/security.md', 'docs/architecture/audit.md'],
        detail_page_size=10, max_detail_page_bytes=196608, max_brief_bytes=65536,
        packages=result, package_count=len(result), shared_contract_source='docs/catalog/shared-contracts.json',
        omission_policy='All selected IDs remain indexed. Read full requirements and acceptance cases on demand; selected context does not change package ownership.')


def check_ownership(root, manifest):
    """Compare the stored projection with catalog owners, without feature inference."""
    catalog = read(root, 'docs/catalog/index.json')
    records = {
        'own_requirement_ids': [r for path in catalog['requirement_files'] for r in read(root, path)['requirements']],
        'own_case_ids': [c for path in catalog['case_files'] for c in read(root, path)['cases']],
        'own_operation_ids': read(root, catalog['operation_source'])['operations'],
    }
    by = {p['id']: p for p in read(root, 'docs/plan/dag.json')['packages']}
    expected = {pid: {field: set() for field in records} for pid in by}
    for field, rows in records.items():
        for row in rows:
            owners = ({row['owning_package']} | set(row['evry_packages'])) if field == 'own_operation_ids' else set(row.get('work_packages', []))
            if not owners <= by.keys():
                raise ValueError('Unknown catalog owner for ' + row['id'])
            for pid in owners:
                expected[pid][field].add(row['id'])
            if field == 'own_requirement_ids' and owners and all(by[pid]['lane'] == 'integration' for pid in owners):
                raise ValueError('Requirement lacks a non-integration owner: ' + row['id'])
    differences = []
    for p in manifest['packages']:
        for field in records:
            delta = set(p[field]) ^ expected[p['id']][field]
            if delta:
                differences.append(p['id'] + '/' + field + ': ' + ', '.join(sorted(delta)))
    if set(expected) != {p['id'] for p in manifest['packages']}:
        raise ValueError('Ownership projection has missing or extra packages')
    if differences:
        raise ValueError('Catalog/manifest ownership differs: ' + '; '.join(differences))
    return sum(len(ids) for fields in expected.values() for ids in fields.values())


def ui_design_links(root, package):
    """Link exact screen-map rows by feature/owner, including undrawn flows."""
    rows = []
    selected = set(package['feature_ids'])
    for number, line in enumerate((root / 'design/handoff/screens.md').read_text().splitlines(), 1):
        if not line.startswith('| '):
            continue
        expanded = set()
        for prefix, start, end in re.findall(r'([A-Z]+)-(\d+) to (?:[A-Z]+-)?(\d+)', line):
            expanded |= {f'{prefix}-{n:03}' for n in range(int(start), int(end) + 1)}
        expanded |= set(re.findall(r'\b[A-Z]+-\d{3}\b', line))
        if package['id'] in line or selected & expanded:
            cells = [cell.strip() for cell in line.strip('|').split('|')]
            label = cells[1] if cells[0].startswith('`#/') else cells[0]
            rows.append(dict(line=number, screen=label, source=f'design/handoff/screens.md#L{number}'))
    return dict(prototype='design/everyfield-marketing.html' if package['id'] == 'WP-097' else 'design/everyfield-ui.html', screen_map='design/handoff/screens.md', rows=rows,
                reading='Open the matching prototype screen and handoff row on demand; compose undrawn flows from the shared components.')


def brief(root, manifest, package):
    dag = read(root, manifest['package_source'])
    own = next(p for p in dag['packages'] if p['id'] == package['id'])
    features = read(root, read(root, manifest['catalog_source'])['feature_source'])
    links = set(own['spec_paths'])
    selected = set(package['feature_ids'])
    for f in features:
        if f['id'] in selected:
            links.add(f['spec_file'].split('#')[0] if own['context_scope']['features'] == 'all' else f['spec_file'])
    links.update(own['context_scope'].get('chapter_links', []))
    requirements = {r['id']: r for path in set(manifest['requirement_locations'][rid]
                    for rid in package['own_requirement_ids']) for r in read(root, path)['requirements']}
    cases = {c['id']: c for path in set(manifest['case_locations'][cid]
             for cid in package['own_case_ids']) for c in read(root, path)['cases']}
    missing = [rid for rid in package['own_requirement_ids'] if not any(
        cid in requirements[rid].get('case_ids', []) or
        rid in [cases[cid]['requirement']] + cases[cid].get('requirement_ids', [])
        for cid in package['own_case_ids'])]
    return dict(
        id=own['id'], title=own['title'], goal=own['goal'], outputs=own['outputs'], owning_paths=own['owning_paths'],
        root_outputs=own.get('root_outputs', []),
        acceptance_gates=own['acceptance_gates'], proof_stage=package['proof_stage'],
        integration_rule=own['integration_rule'], fast_track=own.get('fast_track'),
        ui_specialist=own.get('ui_specialist'), ui_model=own.get('ui_model'),
        own_requirement_ids=package['own_requirement_ids'], own_case_ids=package['own_case_ids'],
        own_operation_ids=package['own_operation_ids'], context_case_ids=package['context_case_ids'],
        case_requirements_at_start=package['case_requirements_at_start'],
        owned_requirements_without_cases=missing,
        chapter_links=sorted(links),
        schema_links={'status': 'current schema on main, not a target; reshape or replace these tables when a feature needs it',
                      'source': 'docs/schema/target.json', 'producer_tables': package['producer_table_names'],
                      'consumer_tables': package['consumer_table_names']},
        direct_prerequisites=own['depends_on'], ui_prerequisites=own.get('ui_depends_on', []),
        design_links=ui_design_links(root, package) if own.get('ui_composition_rule') or own.get('ui_specialist') or own['lane'] == 'ui' else None,
        requirement_portions=own['context_scope'].get('requirement_portions', {}),
        ui_composition_rule=own.get('ui_composition_rule'),
        details=f"python3 docs/package-context.py {own['id']} --part requirements|cases|operations|schema",
        context_policy='Start with this brief. Read linked chapter sections, schema tables and full records on demand. Builders choose filenames and internal code structure. The manifest retains every selected obligation; a brief is not acceptance proof.')


def graph_order(dag):
    by = {p['id']: p for p in dag['packages']}
    order, visiting, visited = [], set(), set()

    def visit(pid):
        if pid in visiting:
            raise ValueError('Dependency cycle at ' + pid)
        if pid in visited:
            return
        if pid not in by:
            raise ValueError('Unknown prerequisite ' + pid)
        visiting.add(pid)
        for dep in by[pid]['depends_on'] + by[pid].get('ui_depends_on', []):
            visit(dep)
        visiting.remove(pid)
        visited.add(pid)
        order.append(pid)

    for pid in sorted(by):
        visit(pid)
    return order


def package_ancestry(dag):
    graph_order(dag)
    by = {p['id']: p for p in dag['packages']}

    @cache
    def ancestors(pid):
        deps = by[pid]['depends_on'] + by[pid].get('ui_depends_on', [])
        return set(deps) | {ancestor for dep in deps for ancestor in ancestors(dep)}

    return ancestors


def exercised_operations(case):
    """Operations a case calls: its action, parallel and additional calls, subcases and declared operation_ids."""
    ops = {case['action']['operation']}
    execution = case.get('given', {}).get('execution', {})
    for field in ['parallel_calls', 'additional_calls']:
        ops |= {call['operation'] for call in execution.get(field, [])}
    for subcase in case.get('subcases', []):
        ops |= exercised_operations(subcase)
    return ops | set(case.get('operation_ids', []))


def gate_ownership_violations(dag, cases, operations, ancestors):
    """A case is a gate for a package only if that package or an ancestor owns every operation it exercises."""
    owner = {o['id']: o['owning_package'] for o in operations}
    violations = []
    for p in dag['packages']:
        for cid in p['acceptance_gates']:
            later = sorted({f'{oid} ({owner[oid]})' for oid in exercised_operations(cases[cid])
                            if oid in owner and owner[oid] != p['id'] and owner[oid] not in ancestors(p['id'])})
            if later:
                violations.append(f"{p['id']}/{cid}: " + ', '.join(later))
    return violations


def check_plan(root, manifest):
    dag = read(root, 'docs/plan/dag.json')
    by = {p['id']: p for p in dag['packages']}
    graph_order(dag)
    check_ownership(root, manifest)
    retired = {p['id'] for p in dag.get('retired_packages', [])}
    if retired & by.keys():
        raise ValueError('Retired package ID reused')
    contexts = {p['id']: p for p in manifest['packages']}

    ancestors = package_ancestry(dag)
    catalog = read(root, 'docs/catalog/index.json')
    cases = {c['id']: c for path in catalog['case_files'] for c in read(root, path)['cases']}

    for p in dag['packages']:
        c = contexts[p['id']]
        if 'fast_track' in p and p['id'] != 'WP-097':
            raise ValueError('Only WP-097 may declare fast_track: ' + p['id'])
        if set(c['case_ids']) & set(c['context_case_ids']):
            raise ValueError('Context-only cases cannot be proof obligations: ' + p['id'])
        for cid in c['case_ids']:
            if not any(owner == p['id'] or owner in ancestors(p['id']) or p['id'] in ancestors(owner)
                       for owner in cases[cid]['work_packages']):
                raise ValueError(p['id'] + ' cannot prove or defer selected case ' + cid + '; keep it context-only')
        if not p['goal'] or not p['owning_paths']:
            raise ValueError('Empty package scope ' + p['id'])
        if any(not x.endswith('/') for x in p['owning_paths']):
            raise ValueError('Owning paths must be directories: ' + p['id'])
        if any(x in ['./', '/'] or x.startswith('./') for x in p['owning_paths']):
            raise ValueError('Unbounded owning path: ' + p['id'])
        if any(not x or '/' in x or x in ['.', '..', 'evf.config.json'] for x in p.get('root_outputs', [])):
            raise ValueError('Root outputs must be bounded scaffold files, outside workflow policy: ' + p['id'])
        if 'status' in p or 'feature_ids' in p:
            raise ValueError('Duplicated DAG state: ' + p['id'])
        if len(encode(brief(root, manifest, c)).encode()) > manifest['max_brief_bytes']:
            raise ValueError('Default brief exceeds byte budget: ' + p['id'])
        if p.get('ui_composition_rule') and not p.get('fast_track'):
            design = {x['id'] for x in dag['packages'] if x['domain'] == 'design-system'}
            if not design <= set(p.get('ui_depends_on', [])) or design & set(p['depends_on']):
                raise ValueError('Feature UI lacks design-system dependency: ' + p['id'])
    adapters = read(root, 'docs/plan/adapter-ownership.json')['adapter_packages']
    operations = read(root, read(root, 'docs/catalog/index.json')['operation_source'])['operations']
    violations = gate_ownership_violations(dag, cases, operations, ancestors)
    if violations:
        raise ValueError(f'Gate ownership fails for {len(violations)} gates; move each gate to the package that owns '
                         'its last operation or to the slice integration package: ' + '; '.join(violations[:20]))
    paths = []
    for adapter in adapters:
        pid = adapter['work_package']
        selected = [o for o in operations if o['id'] in contexts[pid]['own_operation_ids']]
        producers = set(adapter['domain_producers']) | {o['owning_package'] for o in selected}
        missing = producers - ancestors(pid) - {pid}
        if missing:
            raise ValueError(pid + ' lacks producer ancestors ' + str(sorted(missing)))
        for o in selected:
            if adapter['operation_kind'] in ['query', 'command'] and o['kind'] != adapter['operation_kind']:
                raise ValueError('Wrong operation kind: ' + pid + ' ' + o['id'])
        for path in adapter['owning_paths']:
            for owner, previous in paths:
                if path.startswith(previous) or previous.startswith(path):
                    raise ValueError('Overlapping adapter directories: ' + owner + ' and ' + pid)
            paths.append((pid, path))
    # Every operation owner is itself or follows its producer, including kernel work.
    for p in dag['packages']:
        for o in operations:
            if o['id'] in contexts[p['id']]['own_operation_ids'] and o['owning_package'] != p['id'] and o['owning_package'] not in ancestors(p['id']):
                raise ValueError(p['id'] + ' owns an operation before its producer: ' + o['id'])
    # Shared directories must have a reviewed dependency order, not just a conflict hint.
    owners = list(by.values())
    for i, a in enumerate(owners):
        for b in owners[i + 1:]:
            overlap = any(x.startswith(y) or y.startswith(x) for x in a['owning_paths'] for y in b['owning_paths'])
            if overlap and a['id'] not in ancestors(b['id']) and b['id'] not in ancestors(a['id']):
                raise ValueError('Unordered owning path overlap: ' + a['id'] + ' and ' + b['id'])
    seen = set()
    for s in dag['vertical_slices']:
        additions = set(s['required_packages'])
        if additions & seen:
            raise ValueError('Slice repeats packages: ' + s['id'])
        seen |= additions
        if seen != set(s['cumulative_packages']) or any(not set(by[x]['depends_on'] + by[x].get('ui_depends_on', [])) <= seen for x in seen):
            raise ValueError('Slice is not dependency-closed: ' + s['id'])
    if seen != by.keys():
        raise ValueError('Slices do not cover the active target')
    return len(adapters)


def check_case_actions(root, package=None):
    """An owned case can call only operations its package can already provide."""
    dag = read(root, 'docs/plan/dag.json')
    graph_order(dag)
    by = {p['id']: p for p in dag['packages']}
    catalog = read(root, 'docs/catalog/index.json')
    operations = {o['id']: o for o in read(root, catalog['operation_source'])['operations']}
    baseline_policy = read(root, 'docs/plan/case-action-ordering-baseline.json')
    ledger = baseline_policy['entries']
    s0_policy = baseline_policy['s0_policy']
    if s0_policy != 'fail':
        raise ValueError('S0 case-action policy must fail; warning-only S0 repair is complete')
    baseline = {(e['owner'], e['case_id'], e['action_operation'], e['action_owner']) for e in ledger}
    if len(baseline) != len(ledger):
        raise ValueError('Duplicate case-action baseline entry')
    slices = {pid: s['id'] for s in dag['vertical_slices'] for pid in s['required_packages']}
    counts = {s['id']: 0 for s in dag['vertical_slices']}
    if package and package not in by:
        raise ValueError('Unknown package for case-action ordering: ' + package)
    ancestry = {}

    def ancestors(pid):
        if pid not in ancestry:
            ancestry[pid] = {pid}
            for dep in by[pid]['depends_on'] + by[pid].get('ui_depends_on', []):
                ancestry[pid] |= ancestors(dep)
        return ancestry[pid]

    def action_operations(case):
        # Operation selectors/review fixtures are data, not additional invocations.
        yield case['action']['operation']
        execution = case.get('given', {}).get('execution', {})
        for field in ['parallel_calls', 'additional_calls']:
            for call in execution.get(field, []):
                yield call['operation']
        for subcase in case.get('subcases', []):
            yield from action_operations(subcase)

    failures, checked = [], 0
    current_pairs = set()
    for path in catalog['case_files']:
        for case in read(root, path)['cases']:
            actions = set(action_operations(case))
            for pid in case.get('work_packages', []):
                for oid in sorted(actions):
                    # SQL/build/configuration proof actions have no domain package owner;
                    # acceptance/check.py validates those named inspection actions.
                    if oid not in operations:
                        continue
                    owner = operations[oid]['owning_package']
                    entry = (pid, case['id'], oid, owner)
                    unordered = owner not in ancestors(pid)
                    if unordered:
                        current_pairs.add(entry)
                    if package and pid != package:
                        continue
                    checked += 1
                    if unordered:
                        if entry in baseline:
                            counts[slices[pid]] += 1
                        if entry not in baseline or slices[pid] == 'S0' or package:
                            failures.append(f'{pid}/{case["id"]}: {oid} belongs to later or unordered {owner}')
    for pid, case_id, oid, owner in sorted(baseline - current_pairs):
        failures.append(f'{pid}/{case_id}: stale baseline entry for {oid} owned by {owner}')
    print('Open case-action baseline by owning slice: ' + ', '.join(f'{sid}={count}' for sid, count in counts.items()))
    print('Package closure rejects open entries; check a package with WP-NNN --check-case-actions.')
    if failures:
        raise ValueError(f'Owned case action ordering fails: {len(failures)} pairs; ' + '; '.join(failures[:20]))
    return checked


def plan_projection(root, manifest):
    dag = read(root, 'docs/plan/dag.json')
    by = {p['id']: p for p in dag['packages']}
    contexts = {p['id']: p for p in manifest['packages']}
    order = graph_order(dag)
    costs, chains = {}, {}
    for pid in order:
        p, c = by[pid], contexts[pid]
        f = p['estimate_factors']
        case_count = len(c['case_ids'] if c['proof_stage'].startswith('whole-target') else c['own_case_ids'])
        amount = (f['base_days'] + f['requirement_days'] * len(c['own_requirement_ids']) +
                  f['operation_days'] * len(c['own_operation_ids']) + f['case_days'] * case_count +
                  f['table_days'] * len(c['producer_table_names']))
        p['estimate_engineer_days'] = math.ceil(amount * 2) / 2
        dependencies = p['depends_on'] + p.get('ui_depends_on', [])
        prior = max(dependencies, key=lambda x: costs[x]) if dependencies else None
        costs[pid] = p['estimate_engineer_days'] + (costs[prior] if prior else 0)
        chains[pid] = (chains[prior] if prior else []) + [pid]
    last = max(order, key=lambda x: costs[x])
    dag['topological_merge_order'] = order
    dag['edge_count'] = sum(len(p['depends_on']) + len(p.get('ui_depends_on', [])) for p in dag['packages'])
    dag['critical_path'] = chains[last]
    dag['critical_path_unconstrained_days'] = costs[last]
    dag['total_engineer_days'] = sum(p['estimate_engineer_days'] for p in dag['packages'])
    dag['resource_assumptions']['estimates'] = 'Scope-based rough single-owner engineer-days, rounded up to half days. Per-package estimate_factors weight owned clauses, operations, cases and referenced tables. Whole-target integration counts all selected cases. Integration estimates cover checking existing producers, not rebuilding their features.'
    dag['dependency_amendment'] = {'reason': 'Catalog owners precede operation consumers; design prerequisites apply only to presentation tasks; scoped integration producers precede whole-target gates.',
                                   'retired': [p['id'] for p in dag.get('retired_packages', [])], 'ownership_source': 'docs/catalog/index.json'}
    retired = '; '.join(p['id'] + ' is retired into ' + p['scope_moved_to'] for p in dag.get('retired_packages', []))
    notes = dag['build_plan_notes']
    lines = ['# Future build plan', '',
             f"The approved target has {len(by)} active single-owner packages. {retired}; IDs are never reused. Implementation state lives only in docs/build-progress.json.", '',
             'Start with a [short package brief](context.md). Read detailed requirements and cases on demand. The [DAG](dag.json) owns scope and dependencies; builders choose filenames and internal structures within the owned directories.', '',
             f"Rough scope-based effort is {dag['total_engineer_days']:g} engineer-days. The weighted prerequisite lower bound with unconstrained capacity is {costs[last]:g} working days. These are planning estimates, not autonomous-agent throughput or a delivery date. Reviews, real scheduling and external setup add time. Re-estimate after the local runtime and first integrated slice.", '',
             '## Foundation and shared UI', '',
             notes['foundation'], '',
             notes['milestones'], '',
             notes['adapter_ownership'], '',
             '## Vertical slices', '', 'Each row lists only packages newly reached in that dependency-closed slice.', '',
             '| Slice | Delivery | New packages |', '|---|---|---|']
    for s in dag['vertical_slices']:
        lines.append(f"| {s['id']} | {s['meaning']} | {', '.join(s['required_packages'])} |")
    lines += ['', '## Scope estimates', '',
              'The DAG estimates effort from owned clauses, operations, cases and referenced tables. Counts use owned assignments; whole-target integration uses all selected cases. Table counts describe the schema reference, not a requirement to create storage before its feature. Feature implementations choose their internal design.', '',
              '| Package | Task | Clauses | Operations | Cases | Tables | Days |', '|---|---|---:|---:|---:|---:|---:|']
    for pid in order:
        p, c = by[pid], contexts[pid]
        case_count = len(c['case_ids'] if c['proof_stage'].startswith('whole-target') else c['own_case_ids'])
        lines.append(f"| {pid} | {p['title']} | {len(c['own_requirement_ids'])} | {len(c['own_operation_ids'])} | {case_count} | {len(c['producer_table_names'])} | {p['estimate_engineer_days']:g} |")
    lines += ['', '## Package splits', '', 'Integration packages cover all selected acceptance cases after their feature prerequisites.', '']
    for split in dag.get('package_splits', []):
        lines += [split['source'] + ': ' + ', '.join(split['packages']) + '. ' + split['seam'] + ' ' + split['closure'], '']
    lines += ['', '## Critical prerequisite chain', '', ' → '.join(chains[last]), '',
              f"The graph has {dag['edge_count']} edges. The chain above is the maximum sum of scope estimates along prerequisites, calculated by docs/package-context.py --refresh-plan.", '',
              '## Exact dependency graph', '', '```mermaid', 'graph LR']
    for pid in order:
        lines.append(f'  {pid.replace("-", "")}["{pid}: {by[pid]["title"]}"]')
    for pid in order:
        for dep in by[pid]['depends_on']:
            lines.append(f'  {dep.replace("-", "")} --> {pid.replace("-", "")}')
        for dep in by[pid].get('ui_depends_on', []):
            lines.append(f'  {dep.replace("-", "")} -. UI .-> {pid.replace("-", "")}')
    lines += ['```', '', 'Run --check-plan for nonempty scope, directory ownership, disjoint adapter paths, operation-kind ownership, producer ancestry, gate ownership, slice closure, estimates and graph projections. Manifest and planning checks are documentation/tooling proof; they do not establish application acceptance.', '']
    return dag, '\n'.join(lines)



def detail_pages(pid, part, records, manifest):
    """Bound full records by both count and encoded bytes, preserving catalog order."""
    count = len(records)

    def page(rows, number, total):
        return dict(package=pid, part=part, page=number, totalPages=total, selectedCount=count,
                    reading='on demand', records=rows)

    groups, current = [], []
    for record in records:
        candidate = current + [record]
        # The upper bound on page numbers reserves metadata bytes before grouping.
        fits = (len(candidate) <= manifest['detail_page_size'] and
                len(encode(page(candidate, max(1, count), max(1, count))).encode()) <= manifest['max_detail_page_bytes'])
        if not fits and current:
            groups.append(current)
            current = []
        current.append(record)
        if len(encode(page(current, max(1, count), max(1, count))).encode()) > manifest['max_detail_page_bytes']:
            raise ValueError('Single detail record exceeds explicit byte budget: ' + pid + ' ' + part)
    groups.append(current)
    return [page(rows, i + 1, len(groups)) for i, rows in enumerate(groups)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', nargs='?')
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--part', choices=['overview', 'requirements', 'operations', 'cases', 'schema'], default='overview')
    parser.add_argument('--page', type=int, default=1)
    parser.add_argument('--output', type=Path)
    actions = parser.add_mutually_exclusive_group()
    for action in ['check-ownership', 'check-case-actions', 'refresh-manifest', 'check-manifest', 'refresh-plan', 'check-plan', 'brief-sizes', 'acceptance']:
        actions.add_argument('--' + action, action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    if args.check_case_actions:
        checked = check_case_actions(root, args.package)
        print(f'Checked {checked} owned case actions; no new unordered pairs or blocking baseline entries.')
        return
    if args.acceptance:
        sys.stdout.write(encode(load_acceptance(root)))
        return
    manifest = compile_manifest(root)
    if args.check_ownership:
        assignments = check_ownership(root, read(root, 'docs/plan/context-manifest.json'))
        print(f'Catalog/manifest ownership: zero differences across {assignments} assignments, including integration.')
        return
    check_ownership(root, manifest)
    if args.refresh_manifest:
        (root / 'docs/plan/context-manifest.json').write_text(encode(manifest))
        print(f"Generated {manifest['package_count']} current package selectors.")
        return
    if args.check_manifest:
        if read(root, 'docs/plan/context-manifest.json') != manifest:
            raise ValueError('Stale package context manifest')
        print(f"All {manifest['package_count']} package contexts match current catalogs.")
        return
    if args.refresh_plan or args.check_plan:
        adapters = check_plan(root, manifest)
        dag, plan = plan_projection(root, manifest)
        if args.refresh_plan:
            (root / 'docs/plan/dag.json').write_text(encode(dag))
            (root / 'docs/plan/build-plan.md').write_text(plan)
            print('Regenerated scope estimates, topological order, critical path and build plan.')
        else:
            if read(root, 'docs/plan/dag.json') != dag or (root / 'docs/plan/build-plan.md').read_text() != plan:
                raise ValueError('Stale graph estimates or build plan; run --refresh-plan')
            print(f"All {adapters} adapters have producer ancestors and correct operation kinds; package scope, paths, slices and planning projections pass.")
        return
    if args.brief_sizes:
        out = {'measurement': 'UTF-8 bytes of the default indented JSON brief; excludes linked on-demand records and shared files.',
               'packages': {p['id']: len(encode(brief(root, manifest, p)).encode()) for p in manifest['packages']}}
    else:
        package = next((p for p in manifest['packages'] if p['id'] == args.package), None)
        if not package:
            raise ValueError('Choose an active package ID from docs/plan/dag.json')
        if args.part == 'overview':
            out = brief(root, manifest, package)
        else:
            records = []
            catalog = read(root, manifest['catalog_source'])
            if args.part in ['requirements', 'cases']:
                key = 'requirement_ids' if args.part == 'requirements' else 'case_ids'
                field = 'requirements' if args.part == 'requirements' else 'cases'
                locations = manifest['requirement_locations'] if args.part == 'requirements' else manifest['case_locations']
                cache = {}
                for record_id in package[key]:
                    path = locations[record_id]
                    if path not in cache:
                        cache[path] = {x['id']: x for x in read(root, path)[field]}
                    records.append(cache[path][record_id])
            elif args.part == 'operations':
                records = [x for x in read(root, catalog['operation_source'])['operations'] if x['id'] in package['operation_ids']]
            else:
                records = [x for x in load_schema(root) if x['name'] in package['producer_table_names']]
            pages = detail_pages(args.package, args.part, records, manifest)
            if args.page < 1 or args.page > len(pages):
                raise ValueError('Page out of range 1..' + str(len(pages)))
            out = pages[args.page - 1]
    encoded = encode(out)
    if args.part != 'overview' and len(encoded.encode()) > manifest['max_detail_page_bytes']:
        raise ValueError('Detail page exceeds explicit budget; partition records without dropping selected scope')
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded)
    else:
        sys.stdout.write(encoded)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit('ERROR: ' + str(error))
