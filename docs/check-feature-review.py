#!/usr/bin/env python3
"""Check or refresh the owner feature page's catalog projection."""
import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
DATA = re.compile(r'(<script id="feature-data" type="application/json">)(.*?)(</script>)', re.S)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--write', action='store_true')
    args = parser.parse_args()
    features = json.loads((ROOT / 'docs/catalog/features.json').read_text())
    path = ROOT / 'everyfield-feature-review.html'
    html = path.read_text()
    matches = list(DATA.finditer(html))
    if len(matches) != 1:
        raise ValueError('Expected one feature-data script')
    match = matches[0]
    rows = json.loads(match[2])
    expected = [dict(id=f['id'], title=f['title'], story=f['behavior'],
                     kind={'evry': 'Assistant action', 'operations': 'Internal safeguard', 'reference': 'Reference content'}.get(f['module'], 'User feature'),
                     tags=[f['module']], module=f['module'], requirement_ids=f['requirement_ids']) for f in features]
    modules = set(re.findall(r"\['([^']+)'", html[html.index('const modules='):html.index('const moduleMap=')]))
    if modules != {f['module'] for f in features}:
        raise ValueError('Feature page module navigation differs from catalog')
    if args.check:
        if rows != expected:
            raise ValueError('Feature page IDs/modules/requirements or copy differ; run --write')
        print(f'PASS: feature page matches {len(features)} catalog records, modules and requirement IDs')
    else:
        encoded = json.dumps(expected, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
        path.write_text(html[:match.start(2)] + encoded + html[match.end(2):])
        print('Updated feature page from catalog')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        raise SystemExit('ERROR: ' + str(error))
