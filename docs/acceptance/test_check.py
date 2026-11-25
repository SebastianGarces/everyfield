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

    def test_run_cases_name_their_tests(self):
        """INV-case-run: a case marked run names test files that exist and carry its AC tag."""
        self.write('tests/digest.test.mts', 'test("AC:CASE-A shows the digest", () => {});')
        run = dict(self.case('CASE-A'), status='run', run_by=['tests/digest.test.mts'])
        self.fixtures([run], [])
        self.assertEqual(self.check().returncode, 0)
        for broken, message in [
            (dict(run, run_by=['tests/missing.test.mts']), 'tests/missing.test.mts does not run AC:CASE-A'),
            (dict(self.case('CASE-A'), status='run'), 'a run case names its tests in run_by'),
            (dict(self.case('CASE-A'), run_by=['tests/digest.test.mts']), 'run_by needs status run'),
        ]:
            with self.subTest(message=message):
                self.fixtures([broken], [])
                result = self.check()
                self.assertEqual(result.returncode, 1)
                self.assertIn(message, result.stderr)
        self.write('tests/digest.test.mts', 'test("AC:CASE-AB shows another case", () => {});')
        self.fixtures([run], [])
        self.assertIn('does not run AC:CASE-A', self.check().stderr)

    def release(self):
        return subprocess.run(
            [sys.executable, str(HERE / 'check.py'), '--root', str(self.root), '--release'],
            capture_output=True, text=True, check=False,
        )

    def test_release_needs_every_selected_case_run(self):
        """INV-release: a case that is not run fails by name, and a run case passes."""
        run = dict(self.case('CASE-A'), status='run', run_by=['tests/a.test.mts'])
        self.fixtures([run, self.case('CASE-B')], [run | {'id': 'CASE-C'}])
        failed = self.release()
        self.assertEqual(failed.returncode, 1)
        self.assertEqual(failed.stderr.splitlines(), [
            'docs/acceptance/first.json:CASE-B: selected case is future-not-run, not run',
            'FAIL: 1 release findings.'])
        self.assertEqual(failed.stdout.splitlines(), [
            'docs/acceptance/first.json: 2 selected, 1 run, 1 not run, 0 excepted',
            'docs/acceptance/second.json: 1 selected, 1 run, 0 not run, 0 excepted',
            'Total: 3 selected, 2 run, 1 not run, 0 excepted'])
        self.fixtures([run], [run | {'id': 'CASE-C'}])
        passed = self.release()
        self.assertEqual((passed.returncode, passed.stderr), (0, ''))

    def test_release_exceptions_are_listed_with_a_reason(self):
        """INV-release: only a listed ID, a later package and a one-line reason except a case."""
        run = dict(self.case('CASE-A'), status='run', run_by=['tests/a.test.mts'])
        self.fixtures([run, self.case('CASE-B'), self.case('CASE-C')], [])
        listed = {'id': 'CASE-B', 'package': 'WP-094', 'reason': 'Focus is only visible in a browser.'}

        def release(*entries):
            self.write('docs/acceptance/release-exceptions.json', {'exceptions': list(entries)})
            return self.release()
        unlisted = release(listed)
        self.assertEqual(unlisted.returncode, 1)
        self.assertIn('CASE-C: selected case is future-not-run, not run', unlisted.stderr)
        self.assertNotIn('CASE-B', unlisted.stderr)
        self.assertIn('Total: 2 selected, 1 run, 1 not run, 1 excepted', unlisted.stdout)
        other = dict(listed, id='CASE-C')
        self.assertEqual(release(listed, other).returncode, 0)
        for broken, message in [
            (dict(other, reason='  '), 'CASE-C: needs a one-line reason'),
            ({'id': 'CASE-C', 'package': 'WP-094'}, 'CASE-C: needs a one-line reason'),
            (dict(other, reason='One.\nTwo.'), 'CASE-C: needs a one-line reason'),
            (dict(other, package='WP-053'), 'CASE-C: package must be one of'),
            (dict(other, id='CASE-Z'), 'CASE-Z: unknown case'),
            (dict(other, id='CASE-A'), 'CASE-A: the case is run, so remove its exception'),
            (listed, 'CASE-B: listed twice'),
        ]:
            with self.subTest(message=message):
                result = release(listed, broken)
                self.assertEqual(result.returncode, 1)
                self.assertIn(message, result.stderr)


if __name__ == '__main__':
    unittest.main()
