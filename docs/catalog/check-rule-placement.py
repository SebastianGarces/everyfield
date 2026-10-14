#!/usr/bin/env python3
"""Prove lossless behavior-rule placement against the reviewed pre-fix Git baseline.

--write replays the mapping. Baseline Git binds every original occurrence; the ledger names each reviewed rewrite.
Operation rules belong to a requirement listing that operation; shared rules name
one of their requirement's features. Result information is not a code signature.
"""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def original(path, base, root=ROOT):
    return json.loads(subprocess.check_output(['git', 'show', f'{base}:{path}'], cwd=root, text=True))


def requirements(root):
    return {p: json.loads(p.read_text()) for p in (root / 'docs/catalog/requirements').glob('*.json')}


def token(row):
    return json.dumps(row, sort_keys=True, ensure_ascii=False)


def check(root, write=False):
    mapping = json.loads((root / 'docs/catalog/rule-placement.json').read_text())
    base = mapping['baseline']
    rewrites = mapping['rewrites']
    def translated(text):
        return rewrites.get(text, text)
    files = requirements(root)
    current = {r['id']: r for data in files.values() for r in data.get('requirements', [])}
    before = {r['id']: r for p in files for r in original(p.relative_to(root).as_posix(), base, root).get('requirements', [])}
    baseline_links = {(rid, op) for rid, req in before.items() for op in req['operations']}
    added_links = [(row['requirement'], row['operation']) for row in mapping['added_links']]
    assert len(added_links) == len(set(added_links)), 'Duplicate added operation link in ledger'
    assert all(row['reason'].strip() for row in mapping['added_links']), 'Added operation links need a reason'
    for rid, op in added_links:
        assert rid in current and op not in before[rid]['operations'], 'Ledger link is not a baseline addition'
        if write and op not in current[rid]['operations']:
            current[rid]['operations'].append(op)
            current[rid].setdefault('operation_refs', []).append({'operation_id': op, 'catalog': 'docs/catalog/operations.json'})
    head_links = {(rid, op) for rid, req in current.items() for op in req['operations']}
    assert head_links - baseline_links == set(added_links), 'Added operation links differ from reviewed ledger'
    assert baseline_links <= head_links, 'Removed baseline operation link'
    known_text = {b['rule'] for r in before.values() for b in r.get('behavior_rules', [])}
    old_inventory = original('docs/catalog/operations.json', base, root)
    known_text.update(b['rule'] for o in old_inventory['operations'] for b in o['authority'])
    assert set(rewrites) <= known_text, 'Ledger includes an unknown historical rule'
    assert all(old != new for old, new in rewrites.items()), 'Ledger includes a no-op rewrite'
    keys = {(rid, i) for rid, req in before.items() for i, _ in enumerate(req.get('behavior_rules', []))}
    mapped = [(p['from'], p['index']) for p in mapping['placements']]
    assert len(mapped) == len(set(mapped)) and set(mapped) == keys, 'Mapping must preserve every baseline occurrence exactly once'
    expected = defaultdict(list)
    moved = rewritten = 0
    for p in mapping['placements']:
        old = before[p['from']]['behavior_rules'][p['index']]
        req = current[p['to']]
        if old['operation'] == 'shared':
            rule = {'feature': p['feature'], 'rule': translated(old['rule'])}
            assert rule['feature'] in req['feature_ids'], f"Wrong feature placement: {p}"
        else:
            rule = {'operation': old['operation'], 'rule': translated(old['rule'])}
            assert rule['operation'] in req['operations'], f"Wrong operation placement: {p}"
        expected[p['to']].append(rule)
        moved += p['from'] != p['to']
        rewritten += old['rule'] != rule['rule']
    if write:
        for rid, req in current.items():
            if expected[rid]:
                req['behavior_rules'] = expected[rid]
            else:
                req.pop('behavior_rules', None)
        for path, data in files.items():
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    for rid, req in current.items():
        assert Counter(map(token, req.get('behavior_rules', []))) == Counter(map(token, expected[rid])), f'Lost, changed, extra or misplaced rule: {rid}'
        for b in req.get('behavior_rules', []):
            assert not re.search(r'\b\S+\.(?:ts|tsx|js|py)\b|\bpackages/|\b\w+\(\)|\b(?:ActorContext|UnitOfWork|DomainTransaction)\b', b['rule']), f'Code prescription: {rid}'
            assert not re.search(r'[a-z][A-Z]', re.sub(r'\b(?:\d+MiB|EveryField)\b', '', b['rule'])), f'Internal field/type name: {rid}'
    ops_path = root / 'docs/catalog/operations.json'
    operations = json.loads(ops_path.read_text())
    old_operations = {o['id']: o for o in old_inventory['operations']}
    for op in operations['operations']:
        old_rules = old_operations[op['id']]['authority']
        assert len(op['authority']) == len(old_rules), f"Lost authority: {op['id']}"
        for now, old in zip(op['authority'], old_rules):
            if write:
                now['rule'] = translated(old['rule'])
            assert now == {**old, 'rule': translated(old['rule'])}, f"Changed authority: {op['id']}"
    if write:
        header = {k: v for k, v in operations.items() if k != 'operations'}
        text = json.dumps(header, ensure_ascii=False, indent=2)[:-2] + ',\n  "operations": [\n'
        text += ',\n'.join('    ' + json.dumps(o, ensure_ascii=False, separators=(',', ':')) for o in operations['operations'])
        ops_path.write_text(text + '\n  ]\n}\n')
    print(f'PASS: {len(keys)} rules preserved; {moved} moved, {rewritten} rewritten; all operation/feature subjects match their requirements; authority preserved.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    check(args.root.resolve(), args.write)
