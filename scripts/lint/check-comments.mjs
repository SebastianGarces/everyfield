import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RATCHETED } from "./everyfield-plugin.mjs";
import {
	area,
	baselineDir,
	readBaseline,
	readExemptions,
	readSurvivors,
	root,
	SCRIPT_RULES,
	survivorsDir,
} from "./ratchet.mjs";
import { commentScanner, directiveCount, git, inScope, JS, MIGRATIONS, repoFiles } from "./scan.mjs";

const RULES = new Set([...RATCHETED, ...SCRIPT_RULES]);
const FUNCTION_RULES = new Set(["no-effects", "max-state", "no-timers"]);
const BASELINE = "scripts/lint/baseline";
const SURVIVORS = "scripts/lint/survivors";
const CONFIGS = {
	".oxlintrc.json": {
		"*": ["no-comments", "no-effects", "max-state"],
		"packages/*/src/**": ["no-timers", "feature-boundaries"],
	},
	"apps/web/.oxlintrc.json": {
		"*": ["no-comments", "no-effects", "max-state"],
		"src/**": ["no-timers", "clickable-host", "no-cursor-utility", "feature-boundaries"],
	},
	"tools/.oxlintrc.json": { "*": ["no-comments", "no-effects", "max-state"] },
};

const failures = [];
const notices = [];
const fail = (message) => failures.push(message);

const tryGit = (args) => {
	try {
		return git(args).trim();
	} catch {
		return null;
	}
};
const severity = (value) => (Array.isArray(value) ? value[0] : value);

function checkBaselineShape(dir) {
	if (!existsSync(dir)) return;
	for (const rule of readdirSync(dir)) {
		if (!RULES.has(rule))
			fail(`${BASELINE}/${rule}: no lint rule has this name; known rules: ${[...RULES].join(", ")}`);
		const ruleDir = join(dir, rule);
		if (!statSync(ruleDir).isDirectory()) continue;
		for (const name of readdirSync(ruleDir)) {
			const where = `${BASELINE}/${rule}/${name}`;
			const entries = JSON.parse(readFileSync(join(ruleDir, name), "utf8"));
			const keys = Object.keys(entries);
			if (keys.join("\n") !== [...keys].sort().join("\n")) fail(`${where}: entries are not sorted`);
			if (!keys.length) fail(`${where}: holds no entries; delete the file`);
			for (const [path, count] of Object.entries(entries)) {
				if (!Number.isInteger(count) || count < 1) fail(`${where}: ${path} needs a positive whole count`);
				if (`${area(path)}.json` !== name) fail(`${where}: ${path} belongs in ${BASELINE}/${rule}/${area(path)}.json`);
			}
		}
	}
}

function checkSurvivors(files) {
	if (!existsSync(survivorsDir)) return;
	for (const name of readdirSync(survivorsDir)) {
		const content = JSON.parse(readFileSync(join(survivorsDir, name), "utf8"));
		for (const [rule, byPath] of Object.entries(content))
			for (const [path, entries] of Object.entries(byPath)) {
				const where = `${SURVIVORS}/${name}: ${rule} ${path}`;
				if (!RULES.has(rule)) fail(`${where}: no lint rule has this name`);
				if (`${area(path)}.json` !== name) fail(`${where}: belongs in ${SURVIVORS}/${area(path)}.json`);
				if (!files.has(path)) fail(`${where}: the file is gone; delete the entry`);
				if (!Array.isArray(entries) || !entries.length) {
					fail(`${where}: needs a list of { "function", "count", "reason" } entries`);
					continue;
				}
				for (const entry of entries) {
					if (!Number.isInteger(entry.count) || entry.count < 1) fail(`${where}: needs a positive whole count`);
					if (typeof entry.reason !== "string" || entry.reason.trim().length < 20)
						fail(`${where}: needs a reason of 20 characters or more`);
					if (FUNCTION_RULES.has(rule) && (typeof entry.function !== "string" || !entry.function))
						fail(`${where}: needs the name of the function the ${rule} hit sits in`);
				}
			}
	}
}

function offRules(rules = {}) {
	return Object.entries(rules)
		.filter(([, value]) => severity(value) === "off")
		.map(([rule]) => rule);
}

function checkConfigs(exemptions) {
	const reasons = exemptions.configs ?? {};
	for (const [config, required] of Object.entries(CONFIGS)) {
		const json = JSON.parse(readFileSync(join(root, config), "utf8"));
		const given = reasons[config] ?? {};
		const overrides = Object.fromEntries((json.overrides ?? []).map((o) => [o.files.join(", "), o.rules ?? {}]));
		const needs = (what, required, present, explained = {}) => {
			for (const item of required)
				if (typeof explained[item] !== "string" || explained[item].trim().length < 20)
					fail(`${config}: ${what} ${item} needs its reason in scripts/lint/exemptions.json (configs > ${config})`);
			for (const item of Object.keys(explained))
				if (!present.includes(item))
					fail(`scripts/lint/exemptions.json: ${config} ${what} ${item} names nothing in the config`);
		};
		const patterns = json.ignorePatterns ?? [];
		needs("ignore pattern", patterns, patterns, given.ignorePatterns);
		needs("rule", offRules(json.rules), Object.keys(json.rules ?? {}), given.rules);
		for (const [files, rules] of Object.entries(overrides))
			needs(`override for ${files}, rule`, offRules(rules), Object.keys(rules), given.overrides?.[files]);
		for (const files of Object.keys(given.overrides ?? {}))
			if (!(files in overrides)) fail(`scripts/lint/exemptions.json: ${config} has no override for ${files}`);
		for (const [files, rules] of Object.entries(required)) {
			const block = files === "*" ? json.rules : overrides[files];
			for (const rule of rules)
				if (severity(block?.[`everyfield/${rule}`]) !== "error")
					fail(
						`${config}: everyfield/${rule} must be "error" ${files === "*" ? "in the top-level rules" : `in the override for ${files}`}`,
					);
		}
	}
	for (const [glob, reason] of Object.entries(exemptions.comments ?? {}))
		if (typeof reason !== "string" || reason.trim().length < 20)
			fail(`scripts/lint/exemptions.json: comments ${glob} needs a reason`);
}

function checkFiles(baseline, files, newMigrations) {
	const comments = baseline["no-comments"] ?? {};
	const directives = baseline["lint-directives"] ?? {};
	for (const [rule, entries] of Object.entries(baseline))
		for (const path of Object.keys(entries))
			if (!files.has(path)) fail(`${rule}: ${path} is gone; run node scripts/lint/baseline.mjs --shrink`);
	for (const path of files) {
		const migration = newMigrations.has(path);
		if (!migration && (MIGRATIONS.test(path) || !inScope(path))) continue;
		const full = join(root, path);
		if (!existsSync(full) || !statSync(full).isFile()) continue;
		const text = readFileSync(full, "utf8");
		const found = directiveCount(text);
		const allowedDirectives = directives[path] ?? 0;
		if (found > allowedDirectives)
			fail(
				`${path}: ${found} lint or TypeScript directives${allowedDirectives ? `, its baseline allows ${allowedDirectives}` : ""}; fix the code it silences or move the exception into lint config with its reason in scripts/lint/exemptions.json`,
			);
		else if (allowedDirectives && !found)
			fail(`${path}: has no directive left; run node scripts/lint/baseline.mjs --shrink`);
		if (JS.test(path)) continue;
		const lines = commentScanner(path)(text);
		const allowed = migration ? 0 : (comments[path] ?? 0);
		if (lines.length > allowed)
			fail(
				`${path}:${lines[0]}: ${lines.length} comments${allowed ? `, its baseline allows ${allowed}` : ""}; delete them${migration ? " (a new migration starts without comments)" : ""}`,
			);
		else if (allowed && !lines.length)
			fail(`${path}: has no comment left; run node scripts/lint/baseline.mjs --shrink`);
	}
}

function ensureHistory() {
	if (tryGit(["rev-parse", "--is-shallow-repository"]) !== "true") return;
	git(["fetch", "--quiet", "--no-tags", "--unshallow", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
}

export function resolveBase(argv) {
	const given = argv.indexOf("--base");
	if (given !== -1) return { ref: argv[given + 1], how: `--base ${argv[given + 1]}` };
	if (process.env.GITHUB_ACTIONS === "true") {
		const event = process.env.GITHUB_EVENT_NAME;
		const target = process.env.GITHUB_BASE_REF;
		if (event === "pull_request" && target && target !== "main") {
			ensureHistory();
			if (tryGit(["rev-parse", "--verify", "--quiet", "origin/main"]) === null)
				git(["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
			const ref = tryGit(["merge-base", "HEAD", "origin/main"]);
			if (!ref) throw new Error("No merge base between HEAD and origin/main.");
			return { ref, how: `the merge base of HEAD and main (the pull request is stacked on ${target})` };
		}
		return { ref: tryGit(["rev-parse", "HEAD^1"]), how: `the first parent of the ${event} commit` };
	}
	const main = ["origin/main", "main"].find((name) => tryGit(["rev-parse", "--verify", "--quiet", name]) !== null);
	if (!main) return null;
	const ref = tryGit(["merge-base", "HEAD", main]);
	return ref ? { ref, how: `the merge base of HEAD and ${main}` } : null;
}

const trees = new Map();

function treeAt(ref) {
	if (trees.has(ref)) return trees.get(ref);
	const paths = (tryGit(["ls-tree", "-r", "--name-only", "-z", ref, "--", "scripts/lint/"]) ?? "")
		.split("\0")
		.filter((path) => path.endsWith(".json"));
	const blobs = new Map();
	if (paths.length) {
		const out = execFileSync("git", ["cat-file", "--batch"], {
			cwd: root,
			input: paths.map((path) => `${ref}:${path}`).join("\n") + "\n",
			maxBuffer: 1 << 30,
		});
		let at = 0;
		for (const path of paths) {
			const header = out.subarray(at, out.indexOf(10, at)).toString();
			const size = Number(header.split(" ")[2]);
			const start = out.indexOf(10, at) + 1;
			blobs.set(path, JSON.parse(out.subarray(start, start + size).toString()));
			at = start + size + 1;
		}
	}
	trees.set(ref, blobs);
	return blobs;
}

function baselineAt(ref, rule) {
	const prefix = `${BASELINE}/${rule}/`;
	const files = [...treeAt(ref)].filter(([path]) => path.startsWith(prefix));
	return files.length ? Object.assign({}, ...files.map(([, entries]) => entries)) : null;
}

function survivorsAt(ref) {
	const byRule = {};
	for (const [path, content] of treeAt(ref))
		if (path.startsWith(`${SURVIVORS}/`))
			for (const [rule, files] of Object.entries(content)) Object.assign((byRule[rule] ??= {}), files);
	return byRule;
}

export function renamesSince(ref) {
	const fields = git(["diff", "--find-renames", "--name-status", "-z", ref]).split("\0");
	const from = {};
	for (let i = 0; i < fields.length - 1;) {
		const status = fields[i];
		if (status.startsWith("R")) from[fields[i + 2]] = fields[i + 1];
		i += /^[RC]/.test(status) ? 3 : 2;
	}
	return from;
}

const knownAt = (ref, rule) =>
	baselineAt(ref, rule) !== null || tryGit(["grep", "-q", "-F", `"${rule}"`, ref, "--", "scripts/lint/"]) !== null;

function bootstrapCommit(base, rule) {
	if (process.env.GITHUB_ACTIONS === "true") ensureHistory();
	const added = tryGit([
		"log",
		"--reverse",
		"--format=%H",
		"--diff-filter=A",
		`${base}..HEAD`,
		"--",
		`${BASELINE}/${rule}`,
	]);
	return added?.split("\n").find(Boolean) ?? null;
}

function checkGrowth(base, baseline, survivors) {
	const renames = new Map();
	const renamed = (ref) => {
		if (!renames.has(ref)) renames.set(ref, renamesSince(ref));
		return renames.get(ref);
	};
	for (const [rule, entries] of Object.entries(baseline)) {
		let ref = base.ref;
		let before = baselineAt(ref, rule);
		if (before === null && !knownAt(ref, rule)) {
			ref = bootstrapCommit(base.ref, rule);
			if (!ref) {
				notices.push(
					`${rule}: the rule is new against ${base.ref.slice(0, 9)}; its growth check starts with the commit that adds ${BASELINE}/${rule}/`,
				);
				continue;
			}
			notices.push(
				`${rule}: the rule is new against ${base.ref.slice(0, 9)}; its baseline is held to the commit that added it (${ref.slice(0, 9)})`,
			);
			before = baselineAt(ref, rule) ?? {};
		}
		before ??= {};
		for (const [path, count] of Object.entries(entries)) {
			const was = before[path] ?? before[renamed(ref)[path]];
			if (was === undefined)
				fail(`${rule}: ${path} is new to the baseline; the baseline only shrinks, so clean the file instead`);
			else if (count > was) fail(`${rule}: ${path} grew from ${was} to ${count}; the baseline only shrinks`);
		}
	}
	const before = survivorsAt(base.ref);
	const total = (list) => (list ?? []).reduce((sum, entry) => sum + (entry.count ?? 0), 0);
	for (const [rule, files] of Object.entries(survivors))
		for (const [path, list] of Object.entries(files))
			if (total(list) > total(before[rule]?.[path]))
				notices.push(
					`${SURVIVORS}: ${rule} ${path} is new or larger; it waits for the owner (workflow-gates in evf.toml)`,
				);
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const files = new Set(repoFiles());
	const baseline = readBaseline(baselineDir);
	const survivors = readSurvivors(survivorsDir);
	const base = argv.includes("--no-base") ? null : resolveBase(argv);
	const migrationsAtBase = new Set(
		base
			? (tryGit(["ls-tree", "-r", "--name-only", "-z", base.ref, "--", "packages/db/migrations/"]) ?? "").split("\0")
			: [],
	);
	const newMigrations = new Set(
		[...files].filter((path) => base && MIGRATIONS.test(path) && !migrationsAtBase.has(path)),
	);
	checkBaselineShape(baselineDir);
	checkSurvivors(files);
	checkConfigs(readExemptions());
	checkFiles(baseline, files, newMigrations);
	if (base) checkGrowth(base, baseline, survivors);
	else notices.push("No main branch to compare with, so the baseline growth check did not run.");
	for (const notice of notices) console.log(notice);
	if (failures.length) {
		console.error(`Lint baseline and comment checks failed (scripts/lint/check-comments.mjs):\n${failures.join("\n")}`);
		process.exit(1);
	}
	console.log(
		`check-comments: passed${base ? `; baseline growth checked against ${base.ref.slice(0, 9)}, ${base.how}` : ""}`,
	);
}
