#!/usr/bin/env python3
"""Check repository-local Markdown links and literal HTML links in tracked documentation."""
from html.parser import HTMLParser
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
# These source-relative links are retained verbatim in an upstream skill, which is not editable here.
UPSTREAM_LINKS = {
    ('.agents/skills/principle-explain-the-number/SKILL.md', '../benchmark-checklist/SKILL.md'),
    ('.agents/skills/vercel-react-best-practices/AGENTS.md', './async-defer-await.md'),
    ('.agents/skills/vercel-react-best-practices/AGENTS.md', './async-cheap-condition-before-await.md'),
    ('.agents/skills/vercel-react-best-practices/AGENTS.md', './server-hoist-static-io.md'),
}


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in {'href', 'src'} and value:
                self.links.append(value)


def main():
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    errors = []
    upstream_hashes = json.loads((ROOT / 'skills-lock.json').read_text())['skills']
    originals = {f['path']: f['sha256'] for f in json.loads((ROOT / 'docs/reference/manifest.json').read_text())['files']}
    for relative in tracked:
        path = ROOT / relative
        if not path.is_file() or path.suffix not in {'.md', '.html'}:
            continue
        if relative in originals:
            if hashlib.sha256(path.read_bytes()).hexdigest() != originals[relative]:
                errors.append(f'{relative}: immutable reference hash changed')
            # Original source links belong to the source tree, not this portable copy.
            continue
        text = path.read_text()
        if path.suffix == '.md':
            # Fenced code is example content, not a document link.
            text = re.sub(r'^(`{3,}|~{3,})[^\n]*\n.*?^\1\s*$', '', text, flags=re.M | re.S)
            urls = re.findall(r'\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)', text)
        else:
            parser = Links()
            parser.feed(text)
            urls = parser.links
        for url in urls:
            parts = urlsplit(url)
            if parts.scheme or parts.netloc or not parts.path or parts.path.startswith('/'):
                continue
            if (relative, url) in UPSTREAM_LINKS:
                skill = path.parent.name
                pinned = upstream_hashes[skill]
                expected_hash = pinned['sha256'] if path.name == 'SKILL.md' else pinned['fileHashes'][path.name]
                if hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
                    errors.append(f'{relative}: immutable upstream skill hash changed')
                continue
            target = path.parent / unquote(parts.path)
            if not target.exists():
                errors.append(f'{relative}: {url}')
    if errors:
        print('FAIL: missing local link targets\n' + '\n'.join(errors))
        return 1
    print('PASS: local documentation links resolve')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
