#!/usr/bin/env python3
"""Validate docs/catalog/document-templates.json against the template format and class rules."""
import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
CLASSES = {'formal/legal', 'outward-facing', 'operational', 'email'}
SOURCES = {'existing', 'email', 'planned', 'named'}
FIELDS = {'id', 'title', 'class', 'format', 'phase', 'priority', 'source', 'ref'}
EXISTING_IDS = re.compile(r'^    id: "([^"]+)",$', re.M)
EMAIL_NAMES = re.compile(r'^    name: "([^"]+)",$', re.M)


def expected_format(entry):
    """Budgets are XLSX, class email is HTML mail and every other template is PDF."""
    if entry.get('class') == 'email':
        return 'email'
    return 'xlsx' if 'budget' in str(entry.get('id')) else 'pdf'


def check(root):
    catalog = json.loads((root / 'docs/catalog/document-templates.json').read_text())
    errors, seen = [], set()
    templates = catalog['templates']
    for entry in templates:
        name = entry.get('id', '<missing id>')
        if set(entry) != FIELDS:
            errors.append(f'{name}: fields differ from {sorted(FIELDS)}')
        if name in seen:
            errors.append(f'{name}: duplicate id')
        seen.add(name)
        if entry.get('class') not in CLASSES:
            errors.append(f'{name}: class {entry.get("class")!r} is not one of {sorted(CLASSES)}')
        if entry.get('format') != expected_format(entry):
            errors.append(f'{name}: format {entry.get("format")!r} breaks the rule; expected {expected_format(entry)!r}')
        if entry.get('source') not in SOURCES:
            errors.append(f'{name}: source {entry.get("source")!r} is not one of {sorted(SOURCES)}')
        priority, phase = entry.get('priority'), entry.get('phase')
        if priority is not None and priority not in range(1, 6):
            errors.append(f'{name}: priority {priority!r} must be 1 to 5 or null')
        if phase is not None and not isinstance(phase, int):
            errors.append(f'{name}: phase {phase!r} must be a number or null')
        if not entry.get('title') or not entry.get('ref'):
            errors.append(f'{name}: title and ref are required')
    existing = [e['id'] for e in templates if e.get('source') == 'existing']
    reference = EXISTING_IDS.findall((root / 'docs/reference/document-templates.ts').read_text())
    if existing != reference:
        errors.append(f'existing ids {existing} differ from docs/reference/document-templates.ts {reference}')
    emails = [e['title'] for e in templates if e.get('source') == 'email']
    names = EMAIL_NAMES.findall((root / 'docs/reference/communication-system-templates.ts').read_text())
    if emails != names:
        errors.append(f'email titles {emails} differ from docs/reference/communication-system-templates.ts {names}')
    maya = catalog['maya_list']
    if maya['named_here'] != len(templates) or maya['stated_total'] - maya['named_here'] != maya['not_yet_named']:
        errors.append('maya_list counts do not match the template list')
    return errors, len(templates)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    errors, count = check(args.root)
    if errors:
        print('\n'.join('FAIL: ' + e for e in errors))
        return 1
    print(f'PASS: {count} named templates follow the format, class, priority and source rules; existing ids match docs/reference/')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
