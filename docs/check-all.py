#!/usr/bin/env python3
"""Run every documentation check; report all failures instead of stopping at the first."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
TEXT_LINT = 'docs/check-text.py'
CHECKS = [
    ('brand spelling', [TEXT_LINT, '--brand']),
    ('schema', ['docs/schema/check.py']),
    ('schema self-test', ['docs/schema/check.py', '--self-test']),
    ('schema docs freshness', ['docs/schema/render-docs.py', '--check']),
    ('diagram freshness', ['docs/schema/render-diagram.py', '--check']),
    ('architecture', ['docs/schema/check-architecture.py']),
    ('architecture self-test', ['docs/schema/check-architecture.py', '--self-test']),
    ('person references', ['docs/schema/check-person-references.py']),
    ('multiplication contract', ['docs/check-multiplication.py']),
    ('package manifest', ['docs/package-context.py', '--check-manifest']),
    ('package plan', ['docs/package-context.py', '--check-plan']),
    ('owned case action ordering', ['docs/package-context.py', '--check-case-actions']),
    ('operation rules', ['docs/catalog/check-operation-rules.py']),
    ('rule placement', ['docs/catalog/check-rule-placement.py']),
    ('operation references', ['docs/catalog/check-operation-references.py']),
    ('feature projection', ['docs/catalog/project-features.py']),
    ('document template list', ['docs/catalog/check-document-templates.py']),
    ('acceptance cases', ['docs/acceptance/check.py']),
    ('acceptance check self-test', ['-m', 'unittest', 'docs/acceptance/test_check.py']),
    ('document template check self-test', ['-m', 'unittest', 'docs/catalog/test_check_document_templates.py']),
    ('design handoff', ['design/handoff/export.py', '--check']),
    ('feature review page', ['docs/check-feature-review.py', '--check']),
    ('explorer generation', ['docs/render-build-explorer.py', '--check']),
    ('local links', ['docs/check-links.py']),
    ('pinned skills', ['docs/check-skills-lock.py']),
    ('pinned skills self-test', ['docs/check-skills-lock.py', '--self-test']),
    ('Wiki seed', ['tools/wiki/seed.py', 'check', '--seed-dir', 'docs/reference/wiki',
                   '--playbook', 'docs/reference/playbook.md',
                   '--bootstrap', 'docs/reference/bootstrap/global-seed-payload.json']),
    ('text lint', [TEXT_LINT]),
]


def main():
    failures = []
    for name, args in CHECKS:
        print(f'Checking {name}...', flush=True)
        result = subprocess.run([sys.executable, *args], cwd=ROOT)
        if result.returncode:
            failures.append(name)
    if failures:
        print('FAIL: ' + ', '.join(failures))
        return 1
    print('PASS: all documentation checks. Scope is documentation/tooling only.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
