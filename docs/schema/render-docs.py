#!/usr/bin/env python3
"""Generate schema README and relation inventory from the single authority."""
import argparse
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def render(root):
    here = root / 'docs/schema'
    schema = json.loads((here / 'target.json').read_text())
    tables = schema['tables']
    caps = [c for p in sorted((here / 'capabilities').glob('*.json'))
            for c in json.loads(p.read_text())['capabilities']]
    counts = (len(tables), sum(len(t['columns']) for t in tables),
              sum(len(t['foreign_keys']) for t in tables),
              sum(c['type'] == 'jsonb' for t in tables for c in t['columns']))
    readme = ['# Adopted target schema', '',
              '[target.json](target.json) is the only schema authority. Sebastian adopted this reviewed starting design on 2026-10-14. Builders may change it later through a reviewed migration. Application implementation is not authorized by this documentation change.', '',
              'The schema has %s tables, %s columns, %s declared FKs and %s JSONB columns. These are counts of definitions, including compound FKs as one constraint. They exclude indexes, triggers, packaged artifacts and external backups.' % counts, '',
              'Run documentation/tooling checks from the repository root:', '', '```sh',
              'python3 docs/schema/check.py', 'python3 docs/schema/check.py --self-test',
              'python3 docs/schema/render-docs.py --check',
              'python3 docs/schema/render-diagram.py',
              'python3 docs/package-context.py --check-manifest', '```', '',
              '[schema-diagram.html](schema-diagram.html) is an offline ERD generated from this authority. [relations.md](relations.md) lists its exact relations. [design-rules.md](design-rules.md) retains the adopted privacy, history and ownership rules. Capability inventories are under `capabilities/`.', '',
              'The checker validates structural keys, FK existence/arity/types, unconditional referenced keys, owner pairs and named exceptions, UUID relations, literal closed sets, NULL guards, JSONB key documentation, catalog coverage, producer packages and Person registrations. It does not execute SQL, triggers, Better Auth, authorization races, storage, providers or application acceptance. Independent semantic review remains required.', '',
              '## Accepted rulings', '',
              '| ID | Ruling |', '|---|---|',
              '| SCHEMA-ADOPT-1 | Person source is the union of literal sources written by Person-creating operations plus `other` and `meeting_guest_list`. The literal CHECK and `type_contracts.person_source` agree. Ordinary creation/CSV import use that list. See the source evidence below. |',
              '| SCHEMA-ADOPT-2 | Adopt `record` with the actual subtype PK and owner. Trusted insert/deferred triggers validate exact subtype kind, owner and uniqueness. Retained body-free identities confer no access. |',
              '| SCHEMA-ADOPT-3 | Adopt `mail_request` and ordered `mail_request_member`; keep exact request replay, membership, provider key and original clock relational. |',
              '| SCHEMA-ADOPT-4 | Derive current assessment publication from the latest still-authorized complete result, ordered by durable availability and ID. No mutable publication pointer. |',
              '| SCHEMA-ADOPT-5 | Canonical reference definitions remain packaged reviewed release artifacts. Customer editing would require a separate reviewed product change and typed owned rows. |', '',
              'Person source evidence: `REQ-PPL-002` and the `people.quickAddPerson` alias write `other`; `REQ-MTG-011`/`meetings.createGuestContact` writes `meeting_guest_list`. `people.createPerson` and CSV input use `ApprovedRecruitmentSource` without enumerating more literals in the current catalog. Bootstrap/seat linking establishes identity rather than recruitment evidence. No unlisted historical vocabulary is imported.', '',
              '## Producer derivation', '',
              'Each replaced table inherits the union of producer packages from its previous target tables. `legacy_table_producers` retains only that ownership evidence, not a second schema. `producer_derivation` records the source of every table assignment. Every table has a producer, including WP-004 for baseline SQL/trigger proof. Feature selectors derive from capability inventories, rather than stale previous table names.', '',
              '| New table | Ownership basis and ruling | Producers |', '|---|---|---|']
    for t in tables:
        if not t['replaces']:
            basis = t['producer_derivation']
            readme.append('| `%s` | %s | %s |' % (t['name'], basis['rule'], ', '.join(t['producer_work_packages'])))
    readme += ['', '`assessment_fact` also adds WP-040, which owns deterministic fact capture. Its remaining producers inherit the replaced assessment stores. Original-author care excludes generic record/history movement. The Person registry is rebuilt from all adopted Person FKs; generic person-kind record references and frozen opaque inputs are separately registered as immutable evidence.', '',
               '## Previous target to adopted tables', '',
               'This mapping is generated from `replaces`; Fix 2 uses it to align architecture, registries and acceptance. It is a migration guide for documentation, not a customer data migration.', '',
               '| Previous target table | Adopted tables or disposition |', '|---|---|']
    mapping = {n: [] for n in schema['legacy_table_producers']}
    for t in tables:
        for n in t['replaces']:
            mapping[n].append(t['name'])
    for n, targets in sorted(mapping.items()):
        label = ', '.join('`' + t + '`' for t in sorted(targets)) if targets else schema['retired_tables'][n]
        readme.append('| `%s` | %s |' % (n, label))
    readme += ['', '## Coverage', '',
               'Capability inventories cover %s feature IDs and %s persistent capabilities. Coverage proves a documented mapping; it does not establish runtime behavior.' %
               (len({f for c in caps for f in c['feature_ids']}), sum(c['persists'] for c in caps)), '',
               (here / 'design-rules.md').read_text().strip(), '']
    relations = ['# Adopted schema relations', '',
                 'Generated from `target.json`. Compound FK owner pairs and named exceptions are part of the authority. FKs establish identity/integrity; current authorization still comes from the native operation. SQL and trigger proof have not run.', '',
                 '| Child columns | Parent columns | On delete | Scope exception |', '|---|---|---|---|']
    for t in tables:
        for fk in t['foreign_keys']:
            parent = fk['references']
            relations.append('| `%s(%s)` | `%s(%s)` | %s | %s |' %
                             (t['name'], ', '.join(fk['columns']), parent['table'], ', '.join(parent['columns']), fk['on_delete'], fk.get('scope_exception', '').replace('|', '\\|')))
    relations += ['', '## Person references', '',
                  'Every declared Person FK has one registration in `target.json.person_references`. Each registration names lock order, collision/merge choice, guarded inverse, retirement, immutable evidence, private authorship and consumer packages.', '',
                  '| Consumer | Person field and owner | Producers |', '|---|---|---|']
    for r in schema['person_references']:
        relations.append('| `%s` | `%s` | %s |' % (r['table'], ', '.join(r['columns']), ', '.join(r['consumer_work_packages'])))
    return {'README.md': '\n'.join(readme), 'relations.md': '\n'.join(relations) + '\n'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=HERE.parent.parent)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    for name, content in render(args.root).items():
        path = args.root / 'docs/schema' / name
        if args.check:
            if path.read_text() != content:
                print(f'FAIL: {path} differs from authority; rerun render-docs.py')
                return 1
        else:
            path.write_text(content)
    print('PASS: schema documentation matches authority' if args.check else 'Wrote schema README and relations')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
