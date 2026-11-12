#!/usr/bin/env python3
"""Check repository-local links in tracked documentation.

Markdown and literal HTML links must name an existing file. A `#fragment` on a link to a `.md` file (or a same-file
`#fragment`) must match one of that file's headings (GitHub slugs, `-1`/`-2` for repeats, fenced code ignored), an
explicit `id`/`name` anchor or a first-column table row label (D-592). `path.md#anchor` strings in the catalog JSON and
docs/plan/dag.json resolve from the repository root under the same rules. Every pinned skill must still match
skills-lock.json (D-591, via docs/check-skills-lock.py). `--self-test` proves each of these failures on a fixture.
"""
from html.parser import HTMLParser
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
# Schemes a document may link: the web, and the in-page ones the HTML prototypes use.
WEB_SCHEMES = {'http', 'https', 'mailto', 'tel', 'data', 'javascript'}
# These source-relative links are retained verbatim in an upstream skill, which is not editable here.
# check-skills-lock.py proves those skills keep their pinned bytes.
UPSTREAM_LINKS = {
    ('.agents/skills/principle-explain-the-number/SKILL.md', '../benchmark-checklist/SKILL.md'),
    ('.agents/skills/vercel-react-best-practices/AGENTS.md', './async-defer-await.md'),
    ('.agents/skills/vercel-react-best-practices/AGENTS.md', './async-cheap-condition-before-await.md'),
    ('.agents/skills/vercel-react-best-practices/AGENTS.md', './server-hoist-static-io.md'),
}
FENCE = re.compile(r'^ {0,3}(`{3,}|~{3,})[^\n]*\n.*?^ {0,3}\1[`~]*\s*$', re.M | re.S)
JSON_REF = re.compile(r'(?<![\w./-])((?:[\w.-]+/)*[\w.-]+\.md)#([^\s"\'<>)\]]+)')


def _skills_lock_problems():
    spec = importlib.util.spec_from_file_location('check_skills_lock', Path(__file__).with_name('check-skills-lock.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.problems


skills_lock_problems = _skills_lock_problems()


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in {'href', 'src'} and value:
                self.links.append(value)


def slug(heading):
    """GitHub's heading anchor: rendered text, lowercased, punctuation dropped, spaces to hyphens."""
    text = re.sub(r'!?\[([^\]]*)\]\([^)]*\)', r'\1', heading)
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'[^\w\- ]', '', text.strip().lower())
    return text.replace(' ', '-')


def anchors(text):
    """Every fragment a Markdown file answers to."""
    text = FENCE.sub('', text)
    found, seen = set(), {}
    lines = text.split('\n')
    for i, line in enumerate(lines):
        atx = re.match(r' {0,3}#{1,6}(?:\s+(.*?))?(?:\s+#+)?\s*$', line)
        setext = i and re.match(r' {0,3}(=+|-+)\s*$', line) and lines[i - 1].strip() \
            and not lines[i - 1].lstrip().startswith(('|', '-', '#', '>'))
        heading = (atx.group(1) or '') if atx else lines[i - 1] if setext else None
        if heading is None:
            continue
        base = slug(heading)
        count = seen.get(base, 0)
        seen[base] = count + 1
        found.add(base if count == 0 else f'{base}-{count}')
    for line in lines:
        cell = re.match(r'\s*\|\s*([^|]*?)\s*\|', line)
        if cell and cell.group(1):
            found.add(cell.group(1).strip('`*'))
    found.update(re.findall(r'\b(?:id|name)\s*=\s*["\']([^"\']+)["\']', text))
    return found


def check(root, tracked):
    """Disallowed-scheme links, then every other failure."""
    schemes, errors = [], []
    anchor_cache = {}

    def resolves(target, fragment):
        if target not in anchor_cache:
            anchor_cache[target] = anchors(target.read_text())
        return unquote(fragment) in anchor_cache[target]

    manifest = root / 'docs/reference/manifest.json'
    originals = {f['path']: f['sha256'] for f in json.loads(manifest.read_text())['files']} if manifest.is_file() else {}
    for relative in tracked:
        path = root / relative
        if not path.is_file():
            continue
        if path.suffix == '.json' and (relative.startswith('docs/catalog/') or relative == 'docs/plan/dag.json'):
            for ref, fragment in sorted(set(JSON_REF.findall(path.read_text()))):
                target = root / ref
                if not target.is_file() or not resolves(target, fragment):
                    errors.append(f'{relative}: {ref}#{fragment}')
            continue
        if path.suffix not in {'.md', '.html'}:
            continue
        if relative in originals:
            if hashlib.sha256(path.read_bytes()).hexdigest() != originals[relative]:
                errors.append(f'{relative}: immutable reference hash changed')
            # Original source links belong to the source tree, not this portable copy.
            continue
        text = path.read_text()
        if path.suffix == '.md':
            # Fenced code is example content, not a document link.
            urls = re.findall(r'\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)', FENCE.sub('', text))
        else:
            parser = Links()
            parser.feed(text)
            urls = parser.links
        for url in urls:
            parts = urlsplit(url)
            # A link to another tool's private address (such as a retired harness note) can never open from the repo.
            if parts.scheme and parts.scheme not in WEB_SCHEMES:
                schemes.append(f'{relative}: {url}')
                continue
            if parts.scheme or parts.netloc or parts.path.startswith('/') or (relative, url) in UPSTREAM_LINKS:
                continue
            target = path.parent / unquote(parts.path) if parts.path else path
            if not target.exists():
                errors.append(f'{relative}: {url}')
            elif parts.fragment and target.suffix == '.md' and not resolves(target, parts.fragment):
                errors.append(f'{relative}: {url}')
    errors += skills_lock_problems(root)
    return schemes, errors


def self_test():
    digest = lambda data: hashlib.sha256(data).hexdigest()
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        files = {
            'docs/a.md': '# Title\n\n## Same\n\n## Same\n\n```\n## Fenced\n```\n\n| T.2 | row |\n|---|---|\n'
                         '<a id="kept"></a>\n',
            'docs/b.md': '[ok](a.md#same-1) [table](a.md#T.2) [id](a.md#kept) [self](#local)\n\n## Local\n',
            'docs/catalog/x.json': json.dumps({'spec': 'docs/a.md#title'}),
            'docs/plan/dag.json': json.dumps({'links': ['docs/b.md#local']}),
            '.agents/skills/demo/SKILL.md': 'demo\n',
        }
        for relative, text in files.items():
            (root / relative).parent.mkdir(parents=True, exist_ok=True)
            (root / relative).write_text(text)
        (root / 'skills-lock.json').write_text(json.dumps({'skills': {'demo': {'sha256': digest(b'demo\n')}}}))
        tracked = list(files)
        failures = lambda: sum(check(root, tracked), [])
        assert failures() == [], failures()

        clean = (root / 'docs/b.md').read_text()
        (root / 'docs/b.md').write_text(clean + '[bad](a.md#fenced) [row](a.md#T.99)\n')
        assert failures() == ['docs/b.md: a.md#fenced', 'docs/b.md: a.md#T.99'], failures()
        (root / 'docs/b.md').write_text(clean)

        (root / 'docs/b.md').write_text(clean + '[app](intent://open) [gone](missing.md)\n')
        assert check(root, tracked) == (['docs/b.md: intent://open'], ['docs/b.md: missing.md']), check(root, tracked)
        (root / 'docs/b.md').write_text(clean)

        (root / 'docs/catalog/x.json').write_text(json.dumps({'spec': ['docs/a.md#nope', 'docs/gone.md#title']}))
        assert failures() == ['docs/catalog/x.json: docs/a.md#nope', 'docs/catalog/x.json: docs/gone.md#title'], \
            failures()
        (root / 'docs/catalog/x.json').write_text(files['docs/catalog/x.json'])

        (root / '.agents/skills/demo/SKILL.md').write_text('demo!\n')
        found = failures()
        assert len(found) == 1 and 'does not match its skills-lock.json hash' in found[0], found
        (root / '.agents/skills/demo/SKILL.md').write_text('demo\n')
        assert failures() == []
    print('PASS: link check self-test (bad heading anchor, disallowed scheme, bad JSON anchor ref, changed lock hash)')
    return 0


def main(argv):
    if argv == ['--self-test']:
        return self_test()
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    schemes, errors = check(ROOT, tracked)
    if schemes:
        print('FAIL: disallowed link schemes (only web links leave the repository)\n' + '\n'.join(schemes))
    if errors:
        print('FAIL: missing local link targets or anchors\n' + '\n'.join(errors))
    if schemes or errors:
        return 1
    print('PASS: local documentation links, anchors and pinned skills resolve')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
