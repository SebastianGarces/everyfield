#!/usr/bin/env python3
"""Compare planning assignments with a prior commit after editing plan prose."""
import argparse
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[2]
SOURCES = {
    'docs/plan/dag.json': ('packages', 'id', (
        'depends_on', 'ui_depends_on', 'owning_paths', 'root_outputs',
        'context_scope', 'fast_track',
    )),
    'docs/plan/context-manifest.json': ('packages', 'id', (
        'feature_ids', 'own_requirement_ids', 'own_case_ids', 'own_operation_ids',
        'requirement_ids', 'case_ids', 'context_case_ids', 'acceptance_ids',
        'operation_ids', 'shared_contract_ids', 'direct_prerequisites',
        'ui_prerequisites', 'case_requirements_at_start',
    )),
    'docs/plan/release-gates.json': ('gates', 'id', (
        'status', 'work_packages', 'scope', 'authorization', 'source',
    )),
    'docs/plan/adapter-ownership.json': ('adapter_packages', 'work_package', (
        'domain_producers', 'operation_kind', 'owning_paths',
    )),
}


def assignments(data, records, key, fields):
    return {record[key]: {field: record.get(field) for field in fields}
            for record in data[records]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True, help='Git commit before the plan edit')
    args = parser.parse_args()
    failures = []
    for path, (records, key, fields) in SOURCES.items():
        old = json.loads(subprocess.check_output(
            ['git', 'show', f'{args.base}:{path}'], cwd=ROOT, text=True))
        new = json.loads((ROOT / path).read_text())
        # Wording of a scoped requirement may change; its ID and assignment may not.
        if path.endswith('dag.json'):
            for data in (old, new):
                for package in data['packages']:
                    scope = package['context_scope']
                    if 'requirement_portions' in scope:
                        scope['requirement_portions'] = sorted(scope['requirement_portions'])
        if path.endswith('dag.json'):
            for field in ('vertical_slices', 'contract_milestones', 'retired_packages',
                          'topological_merge_order', 'edge_count'):
                if old.get(field) != new.get(field):
                    failures.append(f'{path}: {field} changed')
        before = assignments(old, records, key, fields)
        after = assignments(new, records, key, fields)
        for record_id in sorted(before.keys() | after.keys()):
            if before.get(record_id) != after.get(record_id):
                failures.append(f'{path}: {record_id} changed assignments')
    if failures:
        raise SystemExit('\n'.join(failures))
    print('PASS: package IDs, dependencies, owning paths, selected IDs and approval states preserved.')


if __name__ == '__main__':
    main()
