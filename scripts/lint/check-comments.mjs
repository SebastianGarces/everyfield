import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { lintRuns, oxlintRuns } from "../fast-check.ts";
import { actualCounts } from "./baseline.mjs";
import { RATCHETED } from "./everyfield-plugin.mjs";
import {
	area,
	baselineDir,
	commentsExempt,
	lintDir,
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
		"*": ["no-comments", "no-effects", "max-state", "no-sql-comments"],
		"packages/*/src/**": ["no-timers", "no-render-writes", "feature-boundaries"],
		"packages/ui/src/**": ["no-cursor-utility", "no-global-listeners"],
	},
	"apps/web/.oxlintrc.json": {
		"*": ["no-comments", "no-effects", "max-state", "no-sql-comments"],
		"src/**": [
			"no-timers",
			"clickable-host",
			"no-cursor-utility",
			"no-raw-history",
			"no-global-listeners",
			"zustand-shape",
			"read-loader",
			"no-render-writes",
			"feature-boundaries",
		],
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
					else if (/temporary/i.test(entry.reason) && !/\bT-\d+\b/.test(entry.reason))
						fail(`${where}: a temporary entry must name the evf task (T-<number>) that removes it`);
					if (FUNCTION_RULES.has(rule) && (typeof entry.function !== "string" || !entry.function))
						fail(`${where}: needs the name of the function the ${rule} hit sits in`);
				}
			}
	}
}

const level = (value) => {
	const given = Array.isArray(value) ? value[0] : value;
	if (given === "error" || given === 2) return "error";
	if (given === "warn" || given === 1) return "warn";
	return "off";
};

const CONFIG_KEYS = new Set([
	"$schema",
	"jsPlugins",
	"plugins",
	"categories",
	"rules",
	"overrides",
	"ignorePatterns",
	"env",
	"globals",
	"settings",
]);
const OVERRIDE_KEYS = new Set(["files", "rules", "plugins", "env", "globals"]);
const ESLINT_CONFIGS = {
	"apps/web/eslint.config.mjs": ['{ ignores: [".next/**", "next-env.d.ts"] },'],
	"packages/domain/eslint.config.mjs": ['ignores: ["src/operations/health.ts", "src/operations/telemetry.ts"],'],
};

function checkEslintConfigs(files) {
	for (const path of files)
		if (/(^|\/)eslint\.config\.[cm]?[jt]s$/.test(path) && !(path in ESLINT_CONFIGS))
			fail(`${path}: an ESLint config outside ${Object.keys(ESLINT_CONFIGS).join(", ")} is not allowed`);
	for (const [path, allowed] of Object.entries(ESLINT_CONFIGS)) {
		if (!existsSync(join(root, path))) continue;
		for (const [at, line] of readFileSync(join(root, path), "utf8").split("\n").entries()) {
			const text = line.trim();
			if (/\bignores\b|globalIgnores|ignorePatterns/.test(text) && !allowed.includes(text))
				fail(`${path}:${at + 1}: an ESLint ignore outside the expected ones can hide files`);
			if (/everyfield|noInlineConfig|--no-ignore/.test(text))
				fail(`${path}:${at + 1}: the ESLint config may not name the Everyfield rules or change inline config`);
		}
	}
}

const turnedDown = (rules = {}) =>
	Object.entries(rules)
		.filter(([rule, value]) => (rule.startsWith("everyfield/") ? level(value) !== "error" : level(value) === "off"))
		.map(([rule]) => rule);

const lintScriptsFile = join(lintDir, "lint-scripts.json");
const PLUGIN = fileURLToPath(new URL("./everyfield-plugin.mjs", import.meta.url));

function checkConfigs(exemptions) {
	const reasons = exemptions.configs ?? {};
	for (const [config, required] of Object.entries(CONFIGS)) {
		const json = JSON.parse(readFileSync(join(root, config), "utf8"));
		const given = reasons[config] ?? {};
		const blocks = (json.overrides ?? []).map((o) => ({ ...o, key: (o.files ?? []).join(", "), rules: o.rules ?? {} }));
		const needs = (what, required, present, explained = {}) => {
			for (const item of required)
				if (typeof explained[item] !== "string" || explained[item].trim().length < 20)
					fail(`${config}: ${what} ${item} needs its reason in scripts/lint/exemptions.json (configs > ${config})`);
			for (const item of Object.keys(explained))
				if (!present.includes(item))
					fail(`scripts/lint/exemptions.json: ${config} ${what} ${item} names nothing in the config`);
		};
		for (const key of Object.keys(json))
			if (!CONFIG_KEYS.has(key))
				fail(`${config}: the key ${key} is not allowed; a lint config holds only ${[...CONFIG_KEYS].join(", ")}`);
		const plugins = (json.jsPlugins ?? []).map((plugin) => resolve(dirname(join(root, config)), plugin));
		if (plugins.length !== 1 || plugins[0] !== PLUGIN)
			fail(`${config}: jsPlugins must be exactly the Everyfield plugin, scripts/lint/everyfield-plugin.mjs`);
		const patterns = json.ignorePatterns ?? [];
		needs("ignore pattern", patterns, patterns, given.ignorePatterns);
		needs("rule", turnedDown(json.rules), Object.keys(json.rules ?? {}), given.rules);
		for (const block of blocks) {
			for (const key of Object.keys(block))
				if (key !== "key" && !OVERRIDE_KEYS.has(key))
					fail(
						`${config}: the override for ${block.key} may not set ${key}; an override holds only ${[...OVERRIDE_KEYS].join(", ")}`,
					);
			const present = blocks.filter((other) => other.key === block.key).flatMap((other) => Object.keys(other.rules));
			needs(`override for ${block.key}, rule`, turnedDown(block.rules), present, given.overrides?.[block.key]);
		}
		for (const files of Object.keys(given.overrides ?? {}))
			if (!blocks.some((block) => block.key === files))
				fail(`scripts/lint/exemptions.json: ${config} has no override for ${files}`);
		const overrides = {};
		for (const block of blocks)
			for (const [rule, value] of Object.entries(block.rules))
				if (level(value) === "error") (overrides[block.key] ??= {})[rule] = value;
		for (const [files, rules] of Object.entries(required)) {
			const block = files === "*" ? json.rules : overrides[files];
			for (const rule of rules)
				if (level(block?.[`everyfield/${rule}`]) !== "error")
					fail(
						`${config}: everyfield/${rule} must be "error" ${files === "*" ? "in the top-level rules" : `in the override for ${files}`}`,
					);
		}
	}
	for (const [marker, reason] of Object.entries(exemptions.sqlMarkers ?? {}))
		if (typeof reason !== "string" || reason.trim().length < 20)
			fail(`scripts/lint/exemptions.json: sqlMarkers ${marker} needs a reason`);
	for (const [glob, reason] of Object.entries(exemptions.comments ?? {}))
		if (typeof reason !== "string" || reason.trim().length < 20)
			fail(`scripts/lint/exemptions.json: comments ${glob} needs a reason`);
}

function checkFiles(baseline, files, newMigrations) {
	const comments = baseline["no-comments"] ?? {};
	const directives = baseline["lint-directives"] ?? {};
	for (const [rule, entries] of Object.entries(baseline))
		for (const path of Object.keys(entries))
			if (!files.has(path))
				fail(
					`${rule}: ${path} is gone. If you deleted it, run node scripts/lint/baseline.mjs --shrink; if you moved it, move its entry to the new path in that path's area file (the growth check follows renames).`,
				);
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

const LINT_INPUTS = [
	"scripts/lint",
	"scripts/fast-check.ts",
	"package.json",
	"pnpm-workspace.yaml",
	"pnpm-lock.yaml",
	...Object.keys(CONFIGS),
];

function inputsDigest(ref) {
	const hash = createHash("sha256").update(git(["rev-parse", `${ref}^{commit}`]).trim());
	const walk = (path) => {
		const full = join(root, path);
		if (!existsSync(full)) return;
		if (statSync(full).isDirectory()) {
			for (const name of readdirSync(full).sort()) if (name !== "baseline") walk(`${path}/${name}`);
		} else hash.update(path).update(readFileSync(full));
	};
	const manifests = ["apps", "packages"].flatMap((parent) =>
		existsSync(join(root, parent))
			? readdirSync(join(root, parent))
					.sort()
					.map((name) => `${parent}/${name}/package.json`)
			: [],
	);
	for (const path of [...LINT_INPUTS, ...manifests]) walk(path);
	return hash.digest("hex").slice(0, 32);
}

export function countsAt(ref) {
	const cache = join(tmpdir(), "everyfield-lint-base", `${inputsDigest(ref)}.json`);
	if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
	const tree = realpathSync(mkdtempSync(join(tmpdir(), "everyfield-lint-tree-")));
	try {
		execFileSync("git", ["archive", "--format=tar", "-o", join(tree, ".tree.tar"), ref], { cwd: root });
		execFileSync("tar", ["-xf", ".tree.tar"], { cwd: tree });
		rmSync(join(tree, ".tree.tar"));
		for (const config of Object.keys(CONFIGS)) {
			const json = JSON.parse(readFileSync(join(root, config), "utf8"));
			mkdirSync(dirname(join(tree, config)), { recursive: true });
			writeFileSync(join(tree, config), JSON.stringify({ ...json, jsPlugins: [PLUGIN] }));
		}
		const lintData = join(tree, ".everyfield-lint");
		cpSync(lintDir, lintData, {
			recursive: true,
			filter: (path) => relative(lintDir, path).split(sep)[0] !== "baseline",
		});
		const moved = (path) => join(tree, relative(root, path));
		const runs = oxlintRuns(root).map((run) => ({ ...run, cwd: moved(run.cwd), roots: run.roots.map(moved) }));
		const files = git(["ls-tree", "-r", "--name-only", "-z", ref]).split("\0").filter(Boolean);
		const counts = actualCounts({
			dir: tree,
			runs,
			files,
			env: { EVERYFIELD_ROOT: tree, EVERYFIELD_LINT_DIR: lintData },
		});
		mkdirSync(dirname(cache), { recursive: true });
		const partial = `${cache}.${process.pid}.tmp`;
		writeFileSync(partial, JSON.stringify(counts));
		renameSync(partial, cache);
		return counts;
	} finally {
		rmSync(tree, { recursive: true, force: true });
	}
}

function checkGrowth(base, baseline, survivors) {
	const renamed = renamesSince(base.ref);
	let computed = null;
	for (const [rule, entries] of Object.entries(baseline)) {
		let before = baselineAt(base.ref, rule);
		if (before === null && !knownAt(base.ref, rule)) {
			computed ??= countsAt(base.ref);
			before = computed[rule] ?? {};
			notices.push(
				`${rule}: the rule is new against ${base.ref.slice(0, 9)}; its baseline is held to what the rule reports on that tree`,
			);
		}
		before ??= {};
		for (const [path, count] of Object.entries(entries)) {
			const was = before[path] ?? before[renamed[path]];
			if (was === undefined)
				fail(`${rule}: ${path} is new to the baseline; a baseline never grows, so clean the file instead`);
			else if (count > was) fail(`${rule}: ${path} grew from ${was} to ${count}; a baseline never grows`);
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

const LINT_FLAGS = { oxlint: new Set(["--max-warnings=0"]), eslint: new Set(["--max-warnings=0"]) };
const SHELL = /[|;&<>$`()#\s]/;
const IGNORE_FILES = /(^|\/)(\.eslintignore|\.oxlintignore|\.oxlintrc(\.[\w]+)?|oxlint\.config\.[cm]?[jt]s)$/;

function checkLintScripts() {
	const expected = existsSync(lintScriptsFile) ? JSON.parse(readFileSync(lintScriptsFile, "utf8")) : {};
	const manifests = [
		"package.json",
		...["apps", "packages"].flatMap((parent) =>
			existsSync(join(root, parent))
				? readdirSync(join(root, parent)).map((name) => `${parent}/${name}/package.json`)
				: [],
		),
	].filter((path) => existsSync(join(root, path)));
	for (const path of manifests) {
		const scripts = JSON.parse(readFileSync(join(root, path), "utf8")).scripts ?? {};
		const want = expected[path] ?? {};
		const names = path === "package.json" ? Object.keys(want) : ["lint"];
		for (const name of new Set([...names, ...Object.keys(want)]))
			if (scripts[name] !== want[name])
				fail(
					`${path}: the ${name} script differs from scripts/lint/lint-scripts.json; a lint command changes only together with that expected value`,
				);
	}
	for (const path of Object.keys(expected))
		if (!manifests.includes(path)) fail(`scripts/lint/lint-scripts.json: ${path} does not exist`);
}

function checkLintCommands(files) {
	checkLintScripts();
	checkEslintConfigs(files);
	const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
	const parts = (script) => (script ?? "").split("&&").map((part) => part.trim());
	if (!parts(scripts.lint).includes("pnpm -r --if-present lint"))
		fail("package.json: the lint script must run every package's lint with pnpm -r --if-present lint");
	const configs = new Set(Object.keys(CONFIGS).map((config) => join(root, config)));
	for (const run of lintRuns(root)) {
		const where = `${run.name}'s lint script (${run.tool})`;
		let config = null;
		for (let at = 0; at < run.args.length; at++) {
			const arg = run.args[at];
			if (arg === "-c" || arg === "--config") config = resolve(run.cwd, run.args[++at] ?? "");
			else if (arg.startsWith("-")) {
				if (!LINT_FLAGS[run.tool].has(arg))
					fail(`${where}: the flag ${arg} is not allowed; lint flags can hide files or rules`);
			} else if (SHELL.test(arg) || !existsSync(resolve(run.cwd, arg)))
				fail(`${where}: ${arg} is not an existing lint root`);
		}
		if (!run.args.includes("--max-warnings=0")) fail(`${where}: needs --max-warnings=0`);
		if (run.tool === "oxlint" && !configs.has(config))
			fail(`${where}: must pass -c with one of ${Object.keys(CONFIGS).join(", ")}`);
	}
	for (const path of files) {
		if (IGNORE_FILES.test(path) && !(path in CONFIGS))
			fail(`${path}: lint ignore files and extra Oxlint configs are not allowed; they hide files or rules`);
	}
	const ignored = (tryGit(["ls-files", "-z", "-ci", "--exclude-standard"]) ?? "").split("\0").filter(Boolean);
	for (const path of ignored)
		fail(`${path}: git ignores this tracked file, so lint skips it; un-ignore it or delete it`);
	const roots = oxlintRuns(root).flatMap((run) => run.roots);
	for (const path of files) {
		if (!JS.test(path) || commentsExempt(path) || !existsSync(join(root, path))) continue;
		const full = join(root, path);
		if (!roots.some((dir) => full === dir || full.startsWith(dir + sep)))
			fail(`${path}: no lint run covers this file; move it under a linted folder or add its folder to a lint script`);
	}
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
	checkLintCommands(files);
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
