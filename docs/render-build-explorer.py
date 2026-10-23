#!/usr/bin/env python3
"""Generate a read-only explorer outside the checkout from current inputs and evf progress."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import subprocess
import sys
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('explorer_plan', HERE / 'refresh-explorer-plan.py')
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')


def render(root):
    data = plan.compile_current(root)
    for decision in data['decisions']:
        decision['source'] = (root / decision['source']).as_uri()
    progress = plan.load(root, 'docs/build-progress.json')
    active = {p['id'] for p in data['packages']}
    retired = {p['id'] for p in plan.load(root, 'docs/plan/dag.json').get('retired_packages', [])}
    recorded = set(progress['packages'])
    if recorded - (active | retired) or retired - recorded:
        raise ValueError('Progress IDs differ from active/retired DAG IDs; reconcile through tools/evf/progress.ts --reconcile')
    # Plan PRs precede home-ledger reconciliation. Fill the read-only view, never the ledger.
    for pid in sorted(active - recorded):
        progress['packages'][pid] = dict(status='not_started', evidence=[],
                                        notes='New planned package; no canonical progress recorded yet.')
    for pid, record in progress['packages'].items():
        if (pid in retired) != (record['status'] == 'retired'):
            raise ValueError('Retirement mismatch for ' + pid)
        if record['status'] not in {'not_started', 'in_progress', 'blocked', 'done', 'retired'}:
            raise ValueError('Unknown progress status for ' + pid)
        for task, milestone in record.get('milestones', {}).items():
            if milestone['task'] != task or task.split('/')[0] != pid:
                raise ValueError('Milestone task mismatch for ' + pid)
            for field in ('merge_commit', 'acknowledged', 'stage', 'passed_case_portions', 'passed_gate_portions', 'deferred_case_portions', 'deferred_gate_portions'):
                if field not in milestone:
                    raise ValueError('Missing milestone field ' + field)
    html = (root / 'docs/explorer-ui.template.html').read_text()
    for token, value in [('__CANONICAL_DATA__', data), ('__CANONICAL_PROGRESS__', progress)]:
        if html.count(token) != 1:
            raise ValueError('Expected one template token ' + token)
        html = html.replace(token, encoded(value))
    html = re.sub(r'href="((?:docs/|AGENTS\.md)[^"#]*)(#[^"]*)?"',
                  lambda m: 'href="' + (root / m[1]).as_uri() + (m[2] or '') + '"', html)
    return html


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=HERE.parent)
    parser.add_argument('--output', type=Path, help='HTML destination outside the checkout')
    parser.add_argument('--check', action='store_true', help='check generation; also compare --output when supplied')
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    if args.output and args.output.resolve().is_relative_to(root):
        parser.error('--output must be outside the repository')
    if not args.check and not args.output:
        parser.error('choose --output or --check')
    html = render(root)
    if args.check:
        if args.output and args.output.read_text() != html:
            raise ValueError('Generated explorer is stale; regenerate --output')
        with tempfile.TemporaryDirectory(prefix='evf-explorer-check-') as directory:
            output = Path(directory) / 'explorer.html'
            output.write_text(html)
            if output.read_text() != html:
                raise ValueError('Explorer serialization differs')
            script = Path(directory) / 'explorer.js'
            script.write_text('\n'.join(re.findall(r'<script>(.*?)</script>', html, re.S)))
            result = subprocess.run(['node', '--check', str(script)], capture_output=True, text=True)
            if result.returncode:
                raise ValueError('Explorer JavaScript syntax: ' + result.stderr)
        print('PASS: read-only explorer generated from current catalogs and canonical milestones')
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(html)
        print('Generated explorer: ' + str(args.output))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        raise SystemExit('ERROR: ' + str(error))
