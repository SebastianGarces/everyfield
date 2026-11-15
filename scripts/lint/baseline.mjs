import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { oxlintRuns } from "../fast-check.ts";
import { RATCHETED } from "./everyfield-plugin.mjs";
import { renamesSince, resolveBase } from "./check-comments.mjs";
import { area, baselineDir, readBaseline, root, SCRIPT_RULES } from "./ratchet.mjs";
import { commentScanner, directiveCount, inScope, JS, MIGRATIONS, repoFiles } from "./scan.mjs";

function lintCounts(dir, runs, env) {
	const counts = Object.fromEntries(RATCHETED.map((rule) => [rule, {}]));
	for (const run of runs) {
		const roots = run.roots.filter((path) => existsSync(path));
		if (!roots.length) continue;
		const ran = spawnSync(
			run.bin,
			[...(run.config ? ["-c", run.config] : []), "-f", "json", ...roots.map((path) => relative(run.cwd, path) || ".")],
			{
				cwd: run.cwd,
				encoding: "utf8",
				maxBuffer: 1 << 30,
				env: { ...process.env, ...env, EVERYFIELD_LINT_BASELINE: "off" },
			},
		);
		const report = JSON.parse(ran.stdout.slice(ran.stdout.indexOf("{")));
		const perRun = {};
		for (const d of report.diagnostics) {
			const rule = /^everyfield\(([\w-]+)\)$/.exec(d.code ?? "")?.[1];
			if (!counts[rule]) continue;
			const path = relative(dir, resolve(run.cwd, d.filename)).split(sep).join("/");
			const key = `${rule}\0${path}`;
			perRun[key] = (perRun[key] ?? 0) + 1;
		}
		for (const [key, count] of Object.entries(perRun)) {
			const [rule, path] = key.split("\0");
			counts[rule][path] = Math.max(counts[rule][path] ?? 0, count);
		}
	}
	return counts;
}

function textCounts(counts, dir, files) {
	counts["lint-directives"] = {};
	for (const path of files) {
		if (!inScope(path) || MIGRATIONS.test(path) || !existsSync(join(dir, path))) continue;
		const text = readFileSync(join(dir, path), "utf8");
		const directives = directiveCount(text);
		if (directives) counts["lint-directives"][path] = directives;
		if (JS.test(path)) continue;
		const comments = commentScanner(path)(text).length;
		if (comments) counts["no-comments"][path] = comments;
	}
	return counts;
}

export const actualCounts = ({ dir = root, runs = oxlintRuns(root), files = repoFiles(), env = {} } = {}) =>
	textCounts(lintCounts(dir, runs, env), dir, files);

function write(rule, entries) {
	const dir = join(baselineDir, rule);
	rmSync(dir, { recursive: true, force: true });
	const byArea = {};
	for (const path of Object.keys(entries).sort()) (byArea[area(path)] ??= {})[path] = entries[path];
	if (!Object.keys(byArea).length) return;
	mkdirSync(dir, { recursive: true });
	for (const [name, files] of Object.entries(byArea))
		writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(files, null, "\t")}\n`);
}

function movedSinceBase(argv) {
	const base = resolveBase(argv);
	if (!base) return {};
	return Object.fromEntries(Object.entries(renamesSince(base.ref)).map(([to, from]) => [from, to]));
}

if (import.meta.main) {
	const mode = process.argv[2];
	if (mode !== "--init" && mode !== "--shrink") {
		console.error(
			"usage: node scripts/lint/baseline.mjs --shrink [--base <ref>] | --init\n  --shrink lowers each baseline entry to the file's count now and deletes entries at zero; it never adds. An entry whose file was renamed since the base (the merge base with main, or --base) moves to the new path and area first.\n  --init writes the baseline from scratch; only the commit that introduces a rule may do that, since CI refuses any entry new against main.",
		);
		process.exit(2);
	}
	const actual = actualCounts();
	const before = readBaseline();
	const moved = movedSinceBase(process.argv.slice(3));
	for (const rule of [...RATCHETED, ...SCRIPT_RULES]) {
		const now = actual[rule] ?? {};
		const kept = {};
		if (mode === "--init") Object.assign(kept, now);
		else
			for (const [old, allowed] of Object.entries(before[rule] ?? {})) {
				const path = moved[old] && !existsSync(join(root, old)) ? moved[old] : old;
				if (path !== old) console.log(`${rule}: ${old} moved to ${path}; its entry moves with it`);
				if (now[path]) kept[path] = Math.min(allowed, kept[path] ?? allowed, now[path]);
			}
		write(rule, kept);
		const total = Object.values(kept).reduce((sum, n) => sum + n, 0);
		console.log(`${rule}: ${Object.keys(kept).length} files, ${total} allowed`);
	}
}
