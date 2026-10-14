#!/usr/bin/env python3
"""Generate short package briefs, on-demand details and checked planning projections."""
import argparse
import json
import math
import sys
from pathlib import Path


def read(root, path):
    return json.loads((root / path).read_text())


def encode(value):
    return json.dumps(value, indent=2) + '\n'


ACCEPTANCE_DEFAULTS = {
    'required_test_layers': ['domain/contract', 'PostgreSQL integration where writes/concurrency',
                             'browser/tool evaluation where surfaced'],
    'evidence_status': 'future-not-run',
    'test_protocol': 'Run the selected fixtures through the named domain/native/assistant adapters and applicable real PostgreSQL/browser layers; assert every stated expected result and denial, current state/history/audit/intent coherence, replay and recovery. A failure blocks owning slice closure; no source suite or count establishes a pass.',
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
        op_mode = scope['operations']
        if op_mode == 'explicit':
            own_ops = set(scope['operation_ids'])
        elif op_mode == 'evry_owned':
            own_ops = {o['id'] for o in operations if pid in o['evry_packages']}
        elif op_mode in ['features', 'owned_and_features']:
            own_ops = {o['id'] for o in operations if fs & set(o['feature_ids']) or
                       (op_mode == 'owned_and_features' and pid == o['owning_package'])}
        else:
            raise ValueError('Unknown operation selection ' + op_mode)
        if not own_ops <= op_by.keys():
            raise ValueError('Unknown operation selector for ' + pid)
        req_mode = scope['requirements']
        if req_mode == 'explicit':
            own_rs = set(scope['requirement_ids'])
        elif req_mode in ['features', 'owned_and_features', 'features_and_operations']:
            own_rs = {rid for rid, v in reqs.items() if fs & set(v['record']['feature_ids']) or
                      (req_mode == 'owned_and_features' and pid in v['record'].get('work_packages', [])) or
                      (req_mode == 'features_and_operations' and own_ops & set(v['record'].get('operations', [])))}
        else:
            raise ValueError('Unknown requirement selection ' + req_mode)
        own_rs -= set(scope.get('exclude_requirement_ids', []))
        if not own_rs <= reqs.keys():
            raise ValueError('Unknown requirement selector for ' + pid)
        ac_mode = scope.get('acceptance', 'owned_and_features')
        acs = set(scope['acceptance_ids']) if ac_mode == 'explicit' else {
            a['id'] for a in acceptance if a['feature_id'] in fs or
            (ac_mode == 'owned_and_features' and pid in a['work_packages'])}
        if not acs <= {a['id'] for a in acceptance}:
            raise ValueError('Unknown acceptance selector for ' + pid)
        consumed_ac_rs = {rid for a in acceptance if a['id'] in acs for rid in a['requirement_ids']} - own_rs
        consumed_ac_ops = {oid for a in acceptance if a['id'] in acs for oid in a['operations']} - own_ops
        rs = own_rs | consumed_ac_rs
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
        ops = own_ops | consumed_ac_ops
        unresolved = []
        for rid in rs:
            for operation in reqs[rid]['record'].get('operations', []):
                if operation not in op_by:
                    unresolved.append({'requirement': rid, 'operation': operation})
                else:
                    ops.add(operation)
        # Consuming a clause never grants ownership or model exposure to its referenced operations.
        shared_ops = ops - own_ops
        case_mode = scope['cases']
        if case_mode == 'explicit':
            own_cs = set(scope['case_ids'])
        elif case_mode in ['features', 'owned_and_features', 'operations_and_features']:
            own_cs = {cid for cid, v in cases.items() if fs & set(v['record']['feature_ids']) or
                      (case_mode == 'owned_and_features' and pid in v['record'].get('work_packages', []))}
            own_cs |= {cid for o in operations if o['id'] in own_ops for cid in o['case_ids'] if cid in cases}
            if case_mode == 'owned_and_features':
                own_cs |= {cid for rid in own_rs for cid in reqs[rid]['record'].get('case_ids', []) if cid in cases}
        else:
            raise ValueError('Unknown case selection ' + case_mode)
        if not own_cs <= cases.keys():
            raise ValueError('Unknown case selector for ' + pid)
        cs = own_cs | {cid for a in acceptance if a['id'] in acs for cid in a['case_ids']}
        if case_mode != 'explicit':
            cs |= {cid for rid in rs - own_rs for cid in reqs[rid]['record'].get('case_ids', []) if cid in cases}
        tables = {t['name'] for t in schema if scope['schema'] == 'all' or pid in t['producer_work_packages']}
        result.append(dict(
            id=pid, feature_ids=sorted(fs), own_requirement_ids=sorted(own_rs), own_case_ids=sorted(own_cs),
            own_operation_ids=sorted(own_ops), requirement_ids=sorted(rs), shared_requirement_ids=sorted(rs - own_rs),
            consumed_acceptance_requirement_ids=sorted(consumed_ac_rs), consumed_acceptance_operation_ids=sorted(consumed_ac_ops),
            acceptance_ids=sorted(acs), case_ids=sorted(cs), operation_ids=sorted(ops), shared_operation_ids=sorted(shared_ops),
            shared_contract_ids=sorted(shared_symbols),
            unresolved_current_operation_references=unresolved, direct_prerequisites=p['depends_on'],
            producer_table_names=sorted(tables), consumer_table_names=sorted(
                t['name'] for t in schema if fs & set(t['feature_ids']) and t['name'] not in tables),
            proof_stage=scope['proof_stage'],
            contract_consumption_rule='Selected internal/native-only contracts prove exclusion or producer parity. Consumption grants no model/HTTP exposure or producer ownership.'))
    return dict(
        version=3, scope='Short package briefs and exact on-demand selectors; package scope policy lives in the DAG.',
        catalog_source='docs/catalog/index.json', package_source='docs/plan/dag.json',
        requirement_locations={k: v['path'] for k, v in sorted(reqs.items())},
        case_locations={k: v['path'] for k, v in sorted(cases.items())},
        shared_read_paths=['AGENTS.md', 'docs/START-HERE.md', 'docs/architecture/core.md',
                           'docs/architecture/security.md', 'docs/architecture/audit.md'],
        detail_page_size=10, max_detail_page_bytes=196608, max_brief_bytes=65536,
        packages=result, package_count=len(result), shared_contract_source='docs/catalog/shared-contracts.json',
        omission_policy='All selected IDs remain indexed. Details are on demand; pages report totalPages and selectedCount and never truncate records. Package gates account for owned and explicitly deferred portions, without a mandatory full-packet read.')


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
    return dict(
        id=own['id'], title=own['title'], goal=own['goal'], outputs=own['outputs'], owning_paths=own['owning_paths'],
        own_requirement_ids=package['own_requirement_ids'], own_case_ids=package['own_case_ids'],
        chapter_links=sorted(links),
        schema_links={'source': 'docs/schema/target.json', 'producer_tables': package['producer_table_names'],
                      'consumer_tables': package['consumer_table_names']},
        direct_prerequisites=own['depends_on'],
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
        for dep in by[pid]['depends_on']:
            visit(dep)
        visiting.remove(pid)
        visited.add(pid)
        order.append(pid)

    for pid in sorted(by):
        visit(pid)
    return order


def check_plan(root, manifest):
    dag = read(root, 'docs/plan/dag.json')
    by = {p['id']: p for p in dag['packages']}
    graph_order(dag)
    retired = {p['id'] for p in dag.get('retired_packages', [])}
    if retired & by.keys():
        raise ValueError('Retired package ID reused')
    contexts = {p['id']: p for p in manifest['packages']}

    def ancestors(pid):
        result = set()
        for dep in by[pid]['depends_on']:
            result.add(dep)
            result |= ancestors(dep)
        return result

    for p in dag['packages']:
        c = contexts[p['id']]
        if not p['goal'] or not p['outputs'] or not p['acceptance_gates'] or not p['owning_paths']:
            raise ValueError('Empty package scope ' + p['id'])
        if any(not x.endswith('/') for x in p['owning_paths']):
            raise ValueError('Owning paths must be directories: ' + p['id'])
        if 'status' in p or 'feature_ids' in p:
            raise ValueError('Duplicated DAG state: ' + p['id'])
        if len(encode(brief(root, manifest, c)).encode()) > manifest['max_brief_bytes']:
            raise ValueError('Default brief exceeds byte budget: ' + p['id'])
        if p.get('ui_composition_rule'):
            design = next(x['id'] for x in dag['packages'] if x['domain'] == 'design-system')
            if design not in p['depends_on']:
                raise ValueError('Feature UI lacks design-system dependency: ' + p['id'])
    adapters = read(root, 'docs/plan/adapter-ownership.json')['adapter_packages']
    operations = read(root, read(root, 'docs/catalog/index.json')['operation_source'])['operations']
    paths = []
    for adapter in adapters:
        pid = adapter['work_package']
        selected = [o for o in operations if o['id'] in contexts[pid]['own_operation_ids']]
        producers = set(adapter['domain_producers']) | {o['owning_package'] for o in selected}
        missing = producers - ancestors(pid)
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
    seen = set()
    for s in dag['vertical_slices']:
        additions = set(s['required_packages'])
        if additions & seen:
            raise ValueError('Slice repeats packages: ' + s['id'])
        seen |= additions
        if seen != set(s['cumulative_packages']) or any(not set(by[x]['depends_on']) <= seen for x in seen):
            raise ValueError('Slice is not dependency-closed: ' + s['id'])
    if seen != by.keys():
        raise ValueError('Slices do not cover the active target')
    return len(adapters)


def plan_projection(root, manifest):
    dag = read(root, 'docs/plan/dag.json')
    by = {p['id']: p for p in dag['packages']}
    contexts = {p['id']: p for p in manifest['packages']}
    order = graph_order(dag)
    costs, chains = {}, {}
    for pid in order:
        p, c = by[pid], contexts[pid]
        f = p['estimate_factors']
        amount = (f['base_days'] + f['requirement_days'] * len(c['own_requirement_ids']) +
                  f['operation_days'] * len(c['own_operation_ids']) + f['case_days'] * len(c['own_case_ids']) +
                  f['table_days'] * len(c['producer_table_names']) + f['gate_days'] * len(p['acceptance_gates']))
        p['estimate_engineer_days'] = math.ceil(amount * 2) / 2
        prior = max(p['depends_on'], key=lambda x: costs[x]) if p['depends_on'] else None
        costs[pid] = p['estimate_engineer_days'] + (costs[prior] if prior else 0)
        chains[pid] = (chains[prior] if prior else []) + [pid]
    last = max(order, key=lambda x: costs[x])
    dag['topological_merge_order'] = order
    dag['edge_count'] = sum(len(p['depends_on']) for p in dag['packages'])
    dag['critical_path'] = chains[last]
    dag['critical_path_unconstrained_days'] = costs[last]
    dag['total_engineer_days'] = sum(p['estimate_engineer_days'] for p in dag['packages'])
    dag['resource_assumptions']['estimates'] = 'Scope-based rough single-owner engineer-days, rounded up to half days. Per-package estimate_factors weight owned clauses, operations, cases, produced tables and gates. Integration estimates cover checking existing producers, not rebuilding their features.'
    dag['dependency_amendment'] = {'reason': 'All adapter producers precede consumers; workflow bootstrap and shared UI precede feature work.',
                                   'retired': [p['id'] for p in dag.get('retired_packages', [])], 'ownership_source': 'docs/plan/adapter-ownership.json'}
    retired = '; '.join(p['id'] + ' is retired into ' + p['scope_moved_to'] for p in dag.get('retired_packages', []))
    notes = dag['build_plan_notes']
    lines = ['# Future build plan', '',
             f"The approved target has {len(by)} active single-owner packages. {retired}; IDs are never reused. Implementation state lives only in docs/build-progress.json.", '',
             'Start with a [short package brief](context.md). Read detailed clauses, cases and schema on demand. The [DAG](dag.json) owns scope and dependencies; builders choose filenames and internal structures within the owned directories.', '',
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
              'Each package stores its estimate factors in the DAG. Counts use owned selectors, rather than transitive reading size. Contract and adapter fixtures prove their scoped portions; broad whole-target scripts remain integration work.', '',
              '| Package | Task | Clauses | Operations | Cases | Tables | Days |', '|---|---|---:|---:|---:|---:|---:|']
    for pid in order:
        p, c = by[pid], contexts[pid]
        lines.append(f"| {pid} | {p['title']} | {len(c['own_requirement_ids'])} | {len(c['own_operation_ids'])} | {len(c['own_case_ids'])} | {len(c['producer_table_names'])} | {p['estimate_engineer_days']:g} |")
    lines += ['', '## Critical prerequisite chain', '', ' → '.join(chains[last]), '',
              f"The graph has {dag['edge_count']} edges. The chain above is the maximum sum of scope estimates along prerequisites, calculated by docs/package-context.py --refresh-plan.", '',
              '## Exact dependency graph', '', '```mermaid', 'graph LR']
    for pid in order:
        lines.append(f'  {pid.replace("-", "")}["{pid}: {by[pid]["title"]}"]')
    for pid in order:
        for dep in by[pid]['depends_on']:
            lines.append(f'  {dep.replace("-", "")} --> {pid.replace("-", "")}')
    lines += ['```', '', 'Run --check-plan for nonempty scope, directory ownership, disjoint adapter paths, operation-kind ownership, producer ancestry, slice closure, estimates and graph projections. Manifest and planning checks are documentation/tooling proof; they do not establish application acceptance.', '']
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
    for action in ['refresh-manifest', 'check-manifest', 'refresh-plan', 'check-plan', 'brief-sizes', 'acceptance']:
        actions.add_argument('--' + action, action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    if args.acceptance:
        sys.stdout.write(encode(load_acceptance(root)))
        return
    manifest = compile_manifest(root)
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
