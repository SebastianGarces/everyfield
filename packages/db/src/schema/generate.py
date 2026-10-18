"""Generate current row types; --check compares the full migrated schema with target.json.

Applied migrations are immutable. Schema changes belong in a new numbered migration
and target.json, never in a regenerated 0002 or 0003.
"""
import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
CATALOG = json.loads((ROOT / 'docs/schema/target.json').read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--check-types', action='store_true', help='Offline generated row-type check only')
    parser.add_argument('--env-file', type=Path, help='Approved development environment file for the database check')
    args = parser.parse_args()
    file_table = next(t for t in CATALOG['tables'] if t['name'] == 'file_object')
    types = {'uuid': 'string', 'text': 'string', 'bigint': 'string', 'timestamptz': 'Date'}
    fields = []
    for column in file_table['columns']:
        values = CATALOG['type_contracts'].get('file_object.' + column['name'])
        typ = ' | '.join(json.dumps(v) for v in values) if isinstance(values, list) else types[column['type']]
        fields.append('  ' + column['name'] + ': ' + typ + (' | null' if column['nullable'] else '') + ';')
    row = '// Generated from docs/schema/target.json by generate.py.\nexport interface FileObjectRow {\n' + '\n'.join(fields) + '\n}\n'
    path = Path(__file__).parent / 'file.generated.ts'
    if args.check or args.check_types:
        if path.read_text() != row:
            raise SystemExit('File row type differs from schema catalog.')
    else:
        path.write_text(row)
    if args.check:
        env_file = args.env_file or ROOT / 'apps/web/.env.local'
        return subprocess.call(['node', '--env-file-if-exists=' + str(env_file), str(Path(__file__).with_name('check-current.ts'))], cwd=ROOT)
    print('Current file row type matches target.json.' if args.check_types else 'Generated current file row type. Applied migration bytes unchanged.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
