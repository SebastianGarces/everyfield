"""Operation reference check regressions using a disposable copy, never the live files."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location('check_operation_references', HERE / 'check-operation-references.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class ImplementationRecordTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='evf-operation-references-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / 'docs/catalog/operations.json'
        self.path.parent.mkdir(parents=True)
        shutil.copy(ROOT / 'docs/catalog/operations.json', self.path)
        self.catalog = json.loads(self.path.read_text())
        for op in self.catalog['operations']:
            for path in op.get('implementation', {}).get('paths', []):
                (self.root / path).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(ROOT / path, self.root / path)

    def errors(self):
        self.path.write_text(json.dumps(self.catalog))
        return checker.check(self.root)

    def record(self, op_id):
        return next(o for o in self.catalog['operations'] if o['id'] == op_id)['implementation']

    def test_live_catalog_passes(self):
        self.assertEqual(checker.check(ROOT), [])

    def test_disposable_copy_passes(self):
        self.assertEqual(self.errors(), [])

    def test_unknown_status_fails_with_operation_id(self):
        self.record('orgPeople.export')['status'] = 'planned'
        self.assertEqual(self.errors(), ["orgPeople.export: implementation status 'planned' must be not_built or hand_written"])

    def test_missing_path_fails_with_operation_id(self):
        self.record('security.checkRequestOrigin')['paths'].append('packages/gone.ts')
        self.assertEqual(self.errors(), ["security.checkRequestOrigin: implementation path 'packages/gone.ts' does not exist"])

    def test_path_outside_repo_fails(self):
        self.record('security.checkRequestOrigin')['paths'] = ['../../etc/hosts']
        self.assertEqual(self.errors(), ["security.checkRequestOrigin: implementation path '../../etc/hosts' does not exist"])

    def test_hand_written_needs_paths(self):
        self.record('auth.classifyPublicPreview')['paths'] = []
        self.assertEqual(self.errors(), ['auth.classifyPublicPreview: hand_written implementation needs a non-empty paths list'])

    def test_not_built_takes_no_paths(self):
        self.record('orgPeople.remove')['paths'] = ['packages/domain/src/wiki/reads.ts']
        self.assertEqual(self.errors(), ['orgPeople.remove: not_built implementation takes no paths'])

    def test_note_is_required(self):
        self.record('orgPeople.remove')['note'] = '  '
        self.assertEqual(self.errors(), ['orgPeople.remove: implementation needs a non-empty note'])

    def test_unknown_field_fails(self):
        self.record('orgPeople.export')['owner'] = 'WP-011'
        self.assertEqual(self.errors(), ["orgPeople.export: implementation has unknown fields ['owner']"])


if __name__ == '__main__':
    unittest.main()
