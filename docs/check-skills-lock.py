#!/usr/bin/env python3
"""Every skill pinned in skills-lock.json still has the bytes it was pinned with.

Each entry's SKILL.md under .agents/skills/<name>/ must match its `sha256`, and each file under `fileHashes` must match
its hash. A missing file or a missing `sha256` fails. Update a pinned skill by copying its upstream again and
recording the new hash. `--self-test` proves an edited, missing or unhashed skill fails.
"""
from pathlib import Path
import hashlib
import json
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def problems(root):
    lock = json.loads((root / 'skills-lock.json').read_text())
    found = []
    for name, entry in sorted(lock['skills'].items()):
        folder = root / '.agents/skills' / name
        pinned = [('SKILL.md', entry.get('sha256'))] + sorted((entry.get('fileHashes') or {}).items())
        for relative, expected in pinned:
            path = folder / relative
            shown = path.relative_to(root)
            if not expected:
                found.append(f'{shown}: skills-lock.json entry {name} has no sha256')
            elif not path.is_file():
                found.append(f'{shown}: missing, but skills-lock.json pins it')
            elif hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                found.append(f'{shown}: does not match its skills-lock.json hash; restore the pinned copy')
    return found


def self_test():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        skill = root / '.agents/skills/demo'
        skill.mkdir(parents=True)
        (skill / 'SKILL.md').write_bytes(b'demo\n')
        (skill / 'extra.md').write_bytes(b'extra\n')
        digest = lambda data: hashlib.sha256(data).hexdigest()
        entry = {'sha256': digest(b'demo\n'), 'fileHashes': {'extra.md': digest(b'extra\n')}}
        write = lambda e: (root / 'skills-lock.json').write_text(json.dumps({'skills': {'demo': e}}))
        write(entry)
        assert problems(root) == [], problems(root)
        (skill / 'SKILL.md').write_bytes(b'demo\nx')
        assert 'does not match' in problems(root)[0]
        (skill / 'SKILL.md').write_bytes(b'demo\n')
        (skill / 'extra.md').write_bytes(b'edited\n')
        assert 'extra.md: does not match' in problems(root)[0]
        (skill / 'extra.md').unlink()
        assert 'missing' in problems(root)[0]
        write({'computedHash': entry['sha256']})
        assert 'has no sha256' in problems(root)[0]
    print('PASS: skills-lock self-test')
    return 0


def main(argv):
    if argv == ['--self-test']:
        return self_test()
    found = problems(ROOT)
    for problem in found:
        print('FAIL: ' + problem)
    if found:
        return 1
    print('PASS: every skills-lock.json entry matches its files')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
