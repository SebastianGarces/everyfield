// fast-check: format, lint and typecheck over only the files a branch changes, in seconds and with no database, stack or
// network. The tracked pre-push hook (tools/git-hooks/pre-push) runs it; GitHub CI's full run over the whole repo stays
// required. Each step reads its scope from the script it stands in for, so it follows them when they change: the root
// `format:check` globs, each workspace package's `lint` and `typecheck` scripts, the root lint scripts the root `lint`
// runs with `pnpm run`, the root `typecheck:tools` script and its tsconfig's `include`, and pnpm-workspace.yaml.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, matchesGlob, relative, resolve, sep } from "node:path";

export type StepName = "format" | "lint" | "typecheck";
export type Step = {
	name: StepName;
	status: "passed" | "failed" | "skipped";
	ms: number;
	/** Repo-relative files that fail the step. */
	files: string[];
	/** The command that fixes or reruns the failure. */
	fix?: string;
	/** What the tool said about the failure, or why the step was skipped. */
	detail?: string;
};
export type Report = { ok: boolean; base: { ref: string; sha: string }; files: string[]; ms: number; steps: Step[] };

export class FastCheckError extends Error {}

type Linter = { tool: "oxlint" | "eslint"; bin: string; config?: string };
/** A package's lint: Oxlint first, then ESLint for the rules Oxlint lacks (T-43), each one optional, over the same roots. */
type Lint = { cwd: string; linters: Linter[]; roots: string[] };
type Pkg = { name: string; dir: string; lint?: Lint; typecheck: boolean };

const LINTED = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const INSTALL = "pnpm install";

const git = (root: string, args: string[]) => {
	const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	return run.status === 0 ? run.stdout.trim() : undefined;
};
const quote = (arg: string) => (/^[\w./@:=+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);
const command = (args: string[]) => args.map(quote).join(" ");
const inside = (dir: string, file: string) => file === dir || file.startsWith(dir + sep);

/** The changed files between the merge base of `base` (origin/main, else main) and HEAD, deleted files excluded. */
export function changedFiles(root: string, baseRef?: string): { ref: string; sha: string; files: string[] } {
	const ref =
		baseRef ?? (git(root, ["rev-parse", "--verify", "--quiet", "origin/main"]) !== undefined ? "origin/main" : "main");
	const sha = git(root, ["merge-base", ref, "HEAD"]);
	if (!sha) throw new FastCheckError(`No merge base between ${ref} and HEAD. Pass --base <ref>.`);
	const listed = git(root, ["diff", "--name-only", "-z", "--diff-filter=d", sha, "HEAD"]) ?? "";
	const files = listed
		.split("\0")
		.filter(Boolean)
		.filter((file) => existsSync(join(root, file)));
	return { ref, sha, files };
}

/** The quoted globs of the root `format:check` script. */
function formatGlobs(root: string): string[] {
	const script: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts?.["format:check"] ?? "";
	return [...script.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

/** Reads a package's `lint` script: `[cd <dir> &&] [<oxlint> ... &&] [<eslint> ...] [&& other checks]`, each linter as
 * `<bin> [--config <file>] [flags] <roots...>`. */
function parseLint(dir: string, script: string | undefined): Lint | undefined {
	if (!script) return undefined;
	const parts = script.split("&&").map((part) => part.trim());
	let cwd = dir;
	if (parts[0]?.startsWith("cd ")) cwd = resolve(dir, parts.shift()!.slice(3).trim());
	const lint: Lint = { cwd, linters: [], roots: [] };
	for (const part of parts) {
		const [bin, ...args] = part.split(/\s+/);
		const tool = /(^|\/)(oxlint|eslint)$/.exec(bin ?? "")?.[2] as Linter["tool"] | undefined;
		if (!bin || !tool) break;
		const linter: Linter = { tool, bin: bin === tool ? join(dir, "node_modules/.bin", tool) : resolve(cwd, bin) };
		const roots: string[] = [];
		for (let at = 0; at < args.length; at++) {
			const arg = args[at]!;
			if (arg === "--config" || arg === "-c") linter.config = args[++at];
			else if (!arg.startsWith("-")) roots.push(resolve(cwd, arg));
		}
		lint.linters.push(linter);
		if (!lint.roots.length) lint.roots = roots;
	}
	return lint.linters.length ? lint : undefined;
}

/** The root lint scripts the root `lint` runs with `pnpm run <name>`, each as a package rooted at the repo. */
function rootLints(root: string): Pkg[] {
	const scripts: Record<string, string> = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
	const names = [...(scripts.lint ?? "").matchAll(/\bpnpm run ([\w:-]+)/g)].map((match) => match[1]!);
	return names.flatMap((name) => {
		const lint = parseLint(root, scripts[name]);
		return lint ? [{ name: `root ${name}`, dir: root, lint, typecheck: false }] : [];
	});
}

/** The root `typecheck:tools` script and the `include` globs of the tsconfig it names with `-p`. */
function toolsProject(root: string): { script: string; include: string[] } | undefined {
	const script: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts?.["typecheck:tools"];
	const project = typeof script === "string" ? / -p (\S+)/.exec(script)?.[1] : undefined;
	if (typeof script !== "string" || !project || !existsSync(join(root, project))) return undefined;
	// tsconfig allows whole-line // comments, which JSON.parse does not.
	const config = JSON.parse(readFileSync(join(root, project), "utf8").replace(/^\s*\/\/.*$/gm, ""));
	return { script, include: config.include ?? [] };
}

/** Workspace packages from the `- <dir>/*` entries of pnpm-workspace.yaml. */
function workspacePackages(root: string): Pkg[] {
	const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
	const dirs = [...yaml.matchAll(/^\s*-\s*["']?([^"'\s]+)\/\*["']?\s*$/gm)].flatMap(([, parent]) =>
		readdirSync(join(root, parent!)).map((name) => join(root, parent!, name)),
	);
	return dirs
		.filter((dir) => existsSync(join(dir, "package.json")))
		.map((dir) => {
			const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			return {
				name: manifest.name,
				dir,
				lint: parseLint(dir, manifest.scripts?.lint),
				typecheck: Boolean(manifest.scripts?.typecheck),
			};
		});
}

type Ran = { status: number | null; stdout: string; stderr: string; missing: boolean };
const run = (cwd: string, bin: string, args: string[]) =>
	new Promise<Ran>((done) => {
		const { FORCE_COLOR: _force, ...env } = process.env;
		const child = spawn(bin, args, { cwd, env: { ...env, NO_COLOR: "1" } });
		let stdout = "",
			stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", () => done({ status: null, stdout, stderr, missing: true }));
		child.on("close", (status) => done({ status, stdout, stderr, missing: false }));
	});

const missing = (name: StepName, tool: string, started: number): Step => ({
	name,
	status: "failed",
	ms: Date.now() - started,
	files: [],
	fix: INSTALL,
	detail: `${tool} is not installed.`,
});
const skipped = (name: StepName, detail: string): Step => ({ name, status: "skipped", ms: 0, files: [], detail });

async function format(root: string, changed: string[]): Promise<Step> {
	const globs = formatGlobs(root);
	const files = changed.filter((file) => globs.some((glob) => matchesGlob(file, glob)));
	if (!files.length) return skipped("format", "No changed file matches the format:check globs.");
	const started = Date.now(),
		prettier = join(root, "node_modules/.bin/prettier");
	if (!existsSync(prettier)) return missing("format", "Prettier", started);
	// Prettier skips explicitly named files that .prettierignore lists.
	const ran = await run(root, prettier, ["--check", ...files]);
	const ms = Date.now() - started;
	if (ran.status === 0) return { name: "format", status: "passed", ms, files: [] };
	const output = ran.stdout + ran.stderr;
	const failing = [...output.matchAll(/^\[(?:warn|error)\] (.+?)(?::\s.*)?$/gm)]
		.map((match) => match[1]!)
		.filter((file) => files.includes(file));
	const unique = [...new Set(failing)];
	return {
		name: "format",
		status: "failed",
		ms,
		files: unique,
		fix: command(["pnpm", "exec", "prettier", "--write", ...(unique.length ? unique : files)]),
		detail: output.trim(),
	};
}

type EslintResult = {
	filePath: string;
	errorCount: number;
	warningCount: number;
	messages: { line?: number; column?: number; ruleId?: string | null; message: string }[];
};

type OxlintReport = {
	diagnostics: {
		message: string;
		code?: string;
		filename: string;
		labels?: { span: { line: number; column: number } }[];
	}[];
};

type Linted = Omit<Step, "name" | "ms">;

async function eslintFiles(root: string, cwd: string, linter: Linter, files: string[]): Promise<Linted> {
	const config = linter.config ? ["--config", linter.config] : [];
	const local = files.map((file) => relative(cwd, join(root, file)));
	const ran = await run(cwd, linter.bin, [
		...config,
		"--max-warnings=0",
		"--no-warn-ignored",
		"--format",
		"json",
		...local,
	]);
	if (ran.status === 0) return { status: "passed", files: [] };
	let results: EslintResult[];
	try {
		results = JSON.parse(ran.stdout);
	} catch {
		return { status: "failed", files, detail: (ran.stdout + ran.stderr).trim() };
	}
	const bad = results.filter((result) => result.errorCount + result.warningCount > 0);
	const failing = bad.map((result) => relative(root, result.filePath));
	const at = relative(root, cwd);
	const fixFiles = bad.map((result) => relative(cwd, result.filePath));
	const fix = at
		? command(["pnpm", "--dir", at, "exec", "eslint", ...config, "--fix", ...fixFiles])
		: command([relative(root, linter.bin), ...config, "--fix", ...fixFiles]);
	const detail = bad
		.flatMap((result) =>
			result.messages.map(
				(m) =>
					`${relative(root, result.filePath)}:${m.line ?? 0}:${m.column ?? 0} ${m.message} (${m.ruleId ?? "eslint"})`,
			),
		)
		.join("\n");
	return { status: "failed", files: failing, fix, detail: detail || ran.stderr.trim() };
}

async function oxlintFiles(root: string, cwd: string, linter: Linter, files: string[]): Promise<Linted> {
	const config = linter.config ? ["-c", linter.config] : [];
	const local = files.map((file) => relative(cwd, join(root, file)));
	const ran = await run(cwd, linter.bin, [
		...config,
		"--max-warnings=0",
		"--no-error-on-unmatched-pattern",
		"--format",
		"json",
		...local,
	]);
	if (ran.status === 0) return { status: "passed", files: [] };
	let report: OxlintReport;
	try {
		report = JSON.parse(ran.stdout);
	} catch {
		return { status: "failed", files, detail: (ran.stdout + ran.stderr).trim() };
	}
	const failing = [...new Set(report.diagnostics.map((d) => relative(root, resolve(cwd, d.filename))))];
	const at = relative(root, cwd);
	const fixFiles = failing.map((file) => relative(cwd, join(root, file)));
	const fix = at
		? command(["pnpm", "--dir", at, "exec", "oxlint", ...config, "--fix", ...fixFiles])
		: command([relative(root, linter.bin), ...config, "--fix", ...fixFiles]);
	const detail = report.diagnostics
		.map((d) => {
			const span = d.labels?.[0]?.span;
			return `${relative(root, resolve(cwd, d.filename))}:${span?.line ?? 0}:${span?.column ?? 0} ${d.message} (${d.code ?? "oxlint"})`;
		})
		.join("\n");
	return { status: "failed", files: failing.length ? failing : files, fix, detail: detail || ran.stderr.trim() };
}

async function lintPackage(root: string, lint: Lint, files: string[]): Promise<Linted | "missing"> {
	if (lint.linters.some((linter) => !existsSync(linter.bin))) return "missing";
	const results = await Promise.all(
		lint.linters.map((linter) => (linter.tool === "oxlint" ? oxlintFiles : eslintFiles)(root, lint.cwd, linter, files)),
	);
	const failed = results.filter((result) => result.status === "failed");
	if (!failed.length) return { status: "passed", files: [] };
	return {
		status: "failed",
		files: [...new Set(failed.flatMap((result) => result.files))],
		fix: failed
			.map((result) => result.fix)
			.filter(Boolean)
			.join(" && "),
		detail: failed.map((result) => result.detail).join("\n"),
	};
}

async function lint(root: string, packages: Pkg[], changed: string[]): Promise<Step> {
	const plans = packages.flatMap((pkg) => {
		const lint = pkg.lint;
		if (!lint) return [];
		const files = changed.filter(
			(file) => LINTED.has(extname(file)) && lint.roots.some((dir) => inside(dir, join(root, file))),
		);
		return files.length ? [{ lint, files }] : [];
	});
	if (!plans.length) return skipped("lint", "No changed file is in a package's lint roots.");
	const started = Date.now();
	const results = await Promise.all(plans.map(({ lint, files }) => lintPackage(root, lint, files)));
	const ms = Date.now() - started;
	if (results.includes("missing")) return missing("lint", "Oxlint or ESLint", started);
	const failed = results.filter((result) => result !== "missing" && result.status === "failed") as Omit<
		Step,
		"name" | "ms"
	>[];
	if (!failed.length) return { name: "lint", status: "passed", ms, files: [] };
	return {
		name: "lint",
		status: "failed",
		ms,
		files: failed.flatMap((result) => result.files),
		fix: failed
			.map((result) => result.fix)
			.filter(Boolean)
			.join(" && "),
		detail: failed.map((result) => result.detail).join("\n"),
	};
}

/** The tools config over the tool folders, when a changed file matches its `include`. */
async function typecheckTools(root: string, changed: string[]): Promise<Step | undefined> {
	const tools = toolsProject(root);
	if (!tools || !changed.some((file) => tools.include.some((glob) => matchesGlob(file, glob)))) return undefined;
	const started = Date.now();
	const ran = await run(root, "sh", ["-c", tools.script]);
	// The shell's "not found": node_modules is not installed.
	if (ran.status === 127) return missing("typecheck", "tsc", started);
	const ms = Date.now() - started;
	if (ran.status === 0) return { name: "typecheck", status: "passed", ms, files: [] };
	const output = ran.stdout + ran.stderr;
	const files = [...new Set([...output.matchAll(/^(.+?)\(\d+,\d+\): error TS\d+/gm)].map(([, file]) => file!))];
	const lines = output.split("\n").filter((line) => /error TS\d+/.test(line));
	return {
		name: "typecheck",
		status: "failed",
		ms,
		files,
		fix: "pnpm run typecheck:tools",
		detail: (lines.join("\n") || output).trim(),
	};
}

/** The package typecheck and the tools config, run side by side and reported as one step. */
async function typecheck(root: string, packages: Pkg[], changed: string[]): Promise<Step> {
	const [inPackages, inTools] = await Promise.all([
		typecheckPackages(root, packages, changed),
		typecheckTools(root, changed),
	]);
	if (!inTools) return inPackages;
	if (inPackages.status === "skipped") return inTools;
	const failed = [inPackages, inTools].filter((step) => step.status === "failed");
	return {
		name: "typecheck",
		status: failed.length ? "failed" : "passed",
		ms: Math.max(inPackages.ms, inTools.ms),
		files: failed.flatMap((step) => step.files),
		...(failed.length
			? {
					fix: failed
						.map((step) => step.fix)
						.filter(Boolean)
						.join(" && "),
					detail: failed
						.map((step) => step.detail)
						.filter(Boolean)
						.join("\n"),
				}
			: {}),
	};
}

async function typecheckPackages(root: string, packages: Pkg[], changed: string[]): Promise<Step> {
	// A package owns its folder and the outside roots its lint script names (the tests its tsconfig includes).
	const owned = packages.filter(
		(pkg) =>
			pkg.typecheck &&
			changed.some((file) => [pkg.dir, ...(pkg.lint?.roots ?? [])].some((dir) => inside(dir, join(root, file)))),
	);
	if (!owned.length) return skipped("typecheck", "No changed file is in a package with a typecheck script.");
	const started = Date.now();
	if (owned.some((pkg) => !existsSync(join(pkg.dir, "node_modules/.bin/tsc"))))
		return missing("typecheck", "tsc", started);
	// pnpm's `...[<ref>]` filter finds the repo by its .git folder, so it matches nothing in a git worktree. The
	// changed packages are found above; `...<name>` adds their dependents.
	const args = [...owned.flatMap((pkg) => ["--filter", `...${pkg.name}`]), "--no-bail", "--if-present", "typecheck"];
	const ran = await run(root, "pnpm", args);
	const ms = Date.now() - started;
	const rerun = command(["pnpm", ...args]);
	if (ran.missing)
		return {
			name: "typecheck",
			status: "failed",
			ms,
			files: [],
			fix: "corepack enable pnpm",
			detail: "pnpm is not on PATH.",
		};
	if (ran.status === 0) return { name: "typecheck", status: "passed", ms, files: [] };
	const output = ran.stdout + ran.stderr;
	// pnpm prefixes each line with the package folder: `packages/db typecheck: src/x.ts(3,5): error TS2322: ...`.
	const errors = [...output.matchAll(/^(\S+) typecheck: (.+?)\(\d+,\d+\): error TS\d+/gm)];
	const files = [...new Set(errors.map(([, dir, file]) => relative(root, resolve(root, dir!, file!))))];
	const lines = output.split("\n").filter((line) => /error TS\d+/.test(line));
	return { name: "typecheck", status: "failed", ms, files, fix: rerun, detail: (lines.join("\n") || output).trim() };
}

export async function fastCheck(root: string, baseRef?: string): Promise<Report> {
	const started = Date.now();
	const { ref, sha, files } = changedFiles(root, baseRef);
	const packages = workspacePackages(root);
	const steps = await Promise.all([
		format(root, files),
		lint(root, [...packages, ...rootLints(root)], files),
		typecheck(root, packages, files),
	]);
	return {
		ok: steps.every((step) => step.status !== "failed"),
		base: { ref, sha },
		files,
		ms: Date.now() - started,
		steps,
	};
}

export function render(report: Report): string {
	const lines = [
		`fast-check: ${report.files.length} changed file(s) since ${report.base.ref} (${report.base.sha.slice(0, 9)}), ${report.ms} ms`,
	];
	for (const step of report.steps) {
		const time = step.status === "skipped" ? "" : ` ${step.ms} ms`;
		lines.push(`${step.name.padEnd(10)}${step.status}${time}${step.status === "skipped" ? `: ${step.detail}` : ""}`);
		if (step.status !== "failed") continue;
		for (const file of step.files) lines.push(`  ${file}`);
		if (step.detail)
			lines.push(
				...step.detail
					.split("\n")
					.slice(0, 40)
					.map((line) => `    ${line}`),
			);
		if (step.fix) lines.push(`  fix: ${step.fix}`);
	}
	if (!report.ok) lines.push("Fix the steps above, commit and push again. GitHub CI still runs the full checks.");
	return lines.join("\n");
}
