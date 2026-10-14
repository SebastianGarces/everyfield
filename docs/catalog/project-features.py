#!/usr/bin/env python3
"""Project feature titles/behavior and Evry tools from their authoritative catalogs."""
import argparse
import json
from pathlib import Path


def read(root, path):
    return json.loads((root / path).read_text())


def encode(value):
    return json.dumps(value, indent=2) + '\n'


def project(root):
    index = read(root, 'docs/catalog/index.json')
    requirements = [r for path in index['requirement_files']
                    for r in read(root, path)['requirements']]
    by_id = {r['id']: r for r in requirements}
    if len(by_id) != len(requirements):
        raise ValueError('Duplicate requirement ID')
    features = read(root, index['feature_source'])
    feature_ids = {f['id'] for f in features}
    if len(feature_ids) != len(features):
        raise ValueError('Duplicate feature ID')
    for feature in features:
        rid = 'REQ-' + feature['id']
        requirement = by_id[rid]
        if feature['id'] not in requirement['feature_ids'] or rid not in feature['requirement_ids']:
            raise ValueError('Feature is not linked to its own requirement: ' + feature['id'])
        if not requirement.get('title') or not requirement.get('text'):
            raise ValueError('Own requirement needs a title and text: ' + rid)
        feature['title'] = requirement['title']
        feature['behavior'] = requirement['text']
        feature['spec_file'] = requirement['spec']
    operations = read(root, index['operation_source'])['operations']
    tools = dict(source=index['operation_source'], rule='REQ-EVR-020',
                 operation_ids=sorted(o['id'] for o in operations if o['model_tool']))
    for requirement in requirements:
        if not set(requirement['feature_ids']) <= feature_ids:
            raise ValueError('Unknown requirement feature: ' + requirement['id'])
    for operation in operations:
        if not set(operation['feature_ids']) <= feature_ids:
            raise ValueError('Unknown operation feature: ' + operation['id'])
        if operation['model_tool'] and not operation['evry']:
            raise ValueError('Model tool has no Evry adapter: ' + operation['id'])
    return features, tools


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--write', action='store_true', help='Regenerate projections; default checks only')
    args = parser.parse_args()
    features, tools = project(args.root)
    for path, expected in [('docs/catalog/features.json', features),
                           ('docs/catalog/evry-tools.json', tools)]:
        if args.write:
            (args.root / path).write_text(encode(expected))
        elif read(args.root, path) != expected:
            raise ValueError('Stale projection: ' + path + '; run with --write')
    print(f'{len(features)} feature titles/behaviors match their own requirements; '
          f'{len(tools["operation_ids"])} model tools match the operation flags.')


if __name__ == '__main__':
    main()
