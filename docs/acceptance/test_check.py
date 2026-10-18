"""Case-checker regressions using disposable catalogs, never live build state."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent


class CaseCountTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='evf-case-counts-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.write('docs/catalog/index.json', {
            'requirement_files': [],
            'acceptance_source': 'docs/catalog/acceptance.json',
            'operation_source': 'docs/catalog/operations.json',
            'case_files': ['docs/acceptance/first.json', 'docs/acceptance/second.json'],
            'counts': {'future_cases': 2},
        })
        self.write('docs/catalog/acceptance.json', [])
        self.write('docs/catalog/operations.json', {'operations': []})
        self.write('docs/schema/target.json', {'type_contracts': {}, 'tables': []})
        self.write('docs/plan/dag.json', {
            'packages': [], 'vertical_slices': [{'id': 'S0', 'required_packages': []}],
        })
        self.write('docs/acceptance/case.schema.json', json.loads((HERE / 'case.schema.json').read_text()))

    def write(self, path, value):
        destination = self.root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(value))

    def case(self, case_id):
        return {
            'id': case_id, 'requirement': 'REQ-SYNTHETIC', 'feature_ids': [],
            'acceptance_ids': [], 'work_packages': [], 'status': 'future-not-run',
            'layers': ['build'],
            'given': {'catalog': {'fixture_type': 'catalog', 'version': case_id}},
            'actor': {'account': None, 'session': None, 'context': None},
            'clock': {'now': '2026-10-18T00:00:00Z', 'zone': 'UTC'},
            'action': {'operation': 'build.inspectTargetCatalog', 'arguments': {}},
            'expected': {'state': {}, 'result': {'valid': True}, 'event': None},
        }

    def fixtures(self, first, second):
        for name, cases in [('first', first), ('second', second)]:
            self.write(f'docs/acceptance/{name}.json', {
                'case_schema': 'docs/acceptance/case.schema.json', 'cases': cases,
            })

    def check(self):
        return subprocess.run(
            [sys.executable, str(HERE / 'check.py'), '--root', str(self.root)],
            capture_output=True, text=True, check=False,
        )

    def test_fixture_counts(self):
        """INV-case-counts: adding or removing rows updates totals without metadata edits."""
        for count in [2, 3, 1]:
            with self.subTest(count=count):
                cases = [self.case(f'CASE-{number}') for number in range(count)]
                subcase = copy.deepcopy(cases[0])
                for field in ['id', 'requirement', 'feature_ids', 'acceptance_ids',
                              'work_packages', 'status', 'layers']:
                    del subcase[field]
                subcase['name'] = 'nested-example'
                cases[0]['subcases'] = [subcase]
                self.fixtures(cases[:1], cases[1:])
                result = self.check()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines()[-1],
                                 f'PASS: {count} unique acceptance examples match the case '
                                 'schema and reference graph; no requirement echoes.')

    def test_duplicate_and_missing_cases(self):
        """INV-case-linkage: derived totals still reject duplicates and dangling references."""
        self.fixtures([self.case('CASE-A')], [self.case('CASE-A')])
        duplicate = self.check()
        self.assertEqual(duplicate.returncode, 1)
        self.assertIn('second.json:CASE-A: duplicate case ID', duplicate.stderr)
        self.fixtures([self.case('CASE-A')], [])
        self.write('docs/catalog/acceptance.json', [{'id': 'AC-A', 'case_ids': ['CASE-B']}])
        missing = self.check()
        self.assertEqual(missing.returncode, 1)
        self.assertIn('acceptance AC-A: unknown case CASE-B', missing.stderr)


if __name__ == '__main__':
    unittest.main()
