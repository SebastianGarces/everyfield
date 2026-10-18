import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPackage, git, pathsForPart, run, type Dag, type Part } from './lib.ts';

/** Narrow shared-file rulings a WP task may use outside its owning paths (Spec D14, D16). */
export type ScopeRule = 'own-lock-importer' | 'own-package-scaffold' | 'own-at-start-cases' | 'generated-projection';
export type ScopeReport = { owned: string[]; accepted: Array<{ path: string; rule: ScopeRule }>; outside: string[] };

const SCAFFOLD = ['package.json', 'tsconfig.json', 'eslint.config.mjs'];
const PROJECTIONS = ['docs/plan/context-manifest.json', 'docs/plan/dag.json', 'docs/plan/build-plan.md'];

/** The lockfile with the named importer blocks removed. Blocks are two-space keys under `importers:`. */
export function withoutImporters(lock: string, roots: string[]): string {
  const out: string[] = [];
  let section = '', skipping = false;
  for (const line of lock.split('\n')) {
    if (/^\S/.test(line)) { section = line; skipping = false; }
    else if (section === 'importers:' && /^ {2}\S/.test(line)) skipping = roots.includes(line.trim().replace(/:( \{\})?$/, '').replace(/^'(.*)'$/, '$1'));
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

type CaseFile = { cases: Array<{ id: string; requirement?: string; requirement_ids?: string[]; work_packages?: string[] }> } & Record<string, unknown>;

/** True when head only appends cases owned by `wp` for its at-start requirements; existing content is untouched. */
export function onlyOwnAtStartCases(base: CaseFile, head: CaseFile, wp: string, atStart: string[]): boolean {
  const known = new Set(base.cases.map(c => c.id));
  const added = head.cases.filter(c => !known.has(c.id));
  const kept = { ...head, cases: head.cases.filter(c => known.has(c.id)) };
  return added.length > 0 && JSON.stringify(kept) === JSON.stringify(base) && added.every(c =>
    JSON.stringify(c.work_packages) === JSON.stringify([wp]) && !!c.requirement && atStart.includes(c.requirement)
    && (c.requirement_ids ?? []).every(id => atStart.includes(id)));
}

const show = (wt: string, rev: string, path: string): string | null => {
  const r = run('git', ['show', `${rev}:${path}`], { cwd: wt });
  return r.code === 0 ? r.stdout : null;
};

/** Classifies every path the task changed since `base`, using the base DAG so a task cannot widen its own scope.
 * Generated projections must equal the generators' output on base inputs plus accepted cases. */
export function wpScope(wt: string, base: string, wp: string, part: Part): ScopeReport {
  const baseDag = JSON.parse(show(wt, base, 'docs/plan/dag.json')!) as Dag, pkg = findPackage(baseDag, wp);
  const owningPaths = pathsForPart(pkg, part);
  const changed = git(wt, 'diff', '--name-only', '--no-renames', base, 'HEAD').split('\n').filter(Boolean);
  const owns = (path: string) => owningPaths.some(p => p.endsWith('/') ? path.startsWith(p) : path === p);
  const newRoots = [...new Set(owningPaths.map(p => /^((?:packages|apps)\/[^/]+)\//.exec(p)?.[1]).filter((r): r is string => !!r))]
    .filter(r => run('git', ['cat-file', '-e', `${base}:${r}`], { cwd: wt }).code !== 0);
  const atStart = (pkg.context_scope as { case_requirements_at_start?: string[] }).case_requirements_at_start ?? [];
  const report: ScopeReport = { owned: [], accepted: [], outside: [] };
  const cases: string[] = [];
  for (const path of changed) {
    if (owns(path)) { report.owned.push(path); continue; }
    let rule: ScopeRule | null = null;
    if (newRoots.some(r => SCAFFOLD.some(f => path === `${r}/${f}`))) rule = 'own-package-scaffold';
    else if (path === 'pnpm-lock.yaml' && newRoots.length) {
      const before = show(wt, base, path), after = show(wt, 'HEAD', path);
      if (before !== null && after !== null && withoutImporters(before, newRoots) === before && withoutImporters(after, newRoots) === before) rule = 'own-lock-importer';
    } else if (/^docs\/acceptance\/[^/]+\.json$/.test(path)) {
      const before = show(wt, base, path), after = show(wt, 'HEAD', path);
      try { if (before !== null && after !== null && onlyOwnAtStartCases(JSON.parse(before), JSON.parse(after), wp, atStart)) { rule = 'own-at-start-cases'; cases.push(path); } } catch { /* Unparseable JSON stays outside. */ }
    }
    if (rule) report.accepted.push({ path, rule }); else report.outside.push(path);
  }
  const projections = report.outside.filter(p => PROJECTIONS.includes(p));
  if (projections.length) {
    const tmp = mkdtempSync(join(tmpdir(), 'evf-scope-'));
    try {
      const archive = run('sh', ['-c', `git archive "$1" -- docs design/handoff | tar -x -C "$2"`, 'sh', base, tmp], { cwd: wt });
      for (const path of cases) writeFileSync(join(tmp, path), show(wt, 'HEAD', path)!);
      const generated = archive.code === 0 && ['--refresh-manifest', '--refresh-plan'].every(flag =>
        run('python3', [join(tmp, 'docs/package-context.py'), flag, '--root', tmp], { cwd: tmp }).code === 0);
      for (const path of projections) if (generated && readFileSync(join(tmp, path), 'utf8') === show(wt, 'HEAD', path)) {
        report.outside = report.outside.filter(p => p !== path);
        report.accepted.push({ path, rule: 'generated-projection' });
      }
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  return report;
}
