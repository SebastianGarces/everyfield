"""Template catalog check regressions using a disposable copy, never the live files."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location('check_document_templates', HERE / 'check-document-templates.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class DocumentTemplateCheckTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='evf-document-templates-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for path in ['docs/reference/document-templates.ts', 'docs/reference/communication-system-templates.ts',
                     'docs/catalog/document-templates.json']:
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / path, self.root / path)
        self.path = self.root / 'docs/catalog/document-templates.json'
        self.catalog = json.loads(self.path.read_text())

    def errors(self):
        self.path.write_text(json.dumps(self.catalog))
        return checker.check(self.root)[0]

    def entry(self, template_id):
        return next(t for t in self.catalog['templates'] if t['id'] == template_id)

    def test_live_catalog_passes(self):
        self.assertEqual(self.errors(), [])

    def test_non_budget_template_cannot_be_xlsx(self):
        self.entry('bylaws')['format'] = 'xlsx'
        self.assertEqual(self.errors(), ["bylaws: format 'xlsx' breaks the rule; expected 'pdf'"])

    def test_budget_must_be_xlsx(self):
        self.entry('first-year-budget')['format'] = 'pdf'
        self.assertEqual(self.errors(), ["first-year-budget: format 'pdf' breaks the rule; expected 'xlsx'"])

    def test_email_class_needs_email_format(self):
        self.entry('general-announcement')['format'] = 'pdf'
        self.assertEqual(len(self.errors()), 1)

    def test_unknown_class_and_duplicate_id_fail(self):
        self.entry('bylaws')['class'] = 'decorative'
        self.catalog['templates'].append(dict(self.entry('prayer-letter')))
        messages = self.errors()
        self.assertTrue(any('class' in m for m in messages))
        self.assertTrue(any('duplicate id' in m for m in messages))

    def test_existing_ids_must_match_reference(self):
        self.entry('response-card')['id'] = 'response-card-v2'
        self.assertTrue(any('differ from docs/reference/document-templates.ts' in m for m in self.errors()))

    def test_priority_and_source_are_closed(self):
        self.entry('bylaws')['priority'] = 6
        self.entry('prayer-letter')['source'] = 'guessed'
        self.assertEqual(len(self.errors()), 2)


if __name__ == '__main__':
    unittest.main()
