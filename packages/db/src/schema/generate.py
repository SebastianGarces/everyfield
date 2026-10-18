"""Export the current Drizzle catalog, or verify it against an isolated migrated database."""
import argparse
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--env-file', type=Path, help='Approved development environment file')
    args = parser.parse_args()
    command = ['corepack', 'pnpm', '--filter', '@everyfield/db']
    if not args.check:
        return subprocess.call(command + ['catalog'], cwd=ROOT)
    result = subprocess.call(command + ['schema:check'], cwd=ROOT)
    if result:
        return result
    env_file = args.env_file or ROOT / 'apps/web/.env.local'
    return subprocess.call(command + ['exec', 'tsx', '--env-file-if-exists=' + str(env_file), 'src/schema/check-current.ts'], cwd=ROOT)

if __name__ == '__main__':
    raise SystemExit(main())
