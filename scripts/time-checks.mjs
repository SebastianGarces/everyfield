// Times the current and the new form of each check change T-43 weighs (lint, the `next build` type check, test
// isolation), so a change is adopted only at a measured saving of 25% or more.
//
//   node scripts/time-checks.mjs [--runs 3] [--only lint,build,isolation] [--base <ref>] [--out <dir>]
//
// The current form is the check as it is on --base (default: the merge base with origin/main); the new form is the
// working tree. Runs alternate current and new so a load change hits both. Each run records wall time, the peak
// resident memory of its largest process and the 1-minute load average at its start. Results go to --out (default
// $TMPDIR/time-checks/<time>), never inside the checkout.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, loadavg, platform, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
	options: {
		runs: { type: "string", default: "3" },
		only: { type: "string", default: "lint,build,isolation" },
		base: { type: "string" },
		out: { type: "string" },
		// Clear .next/cache before each build too, as a CI runner without a cache hit starts.
		cold: { type: "boolean", default: false },
	},
});

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const base = args.base ?? git("merge-base", "HEAD", "origin/main");
const runs = Number(args.runs);
const out = resolve(args.out ?? join(tmpdir(), "time-checks", new Date().toISOString().replace(/[:.]/g, "-")));
if (!relative(root, out).startsWith("..")) throw new Error(`--out must be outside the checkout: ${out}`);
mkdirSync(out, { recursive: true });

const atBase = (path) => {
	try {
		return git("show", `${base}:${path}`);
	} catch {
		return null;
	}
};
const lintPackages = ["apps/web", ...readdirSync(join(root, "packages")).map((name) => `packages/${name}`)];
const scriptOf = (pkg, name, text) =>
	JSON.parse(text ?? readFileSync(join(root, pkg, "package.json"), "utf8")).scripts?.[name];

/** The lint steps of a lint script: everything up to its last oxlint or eslint step, not the web image checks. */
function linterSteps(script) {
	const steps = script.split(" && ");
	const last = steps.findLastIndex((step) => /\b(oxlint|eslint)\b/.test(step));
	return steps.slice(0, last + 1);
}

/** Rewrites a base-ref ESLint config so it imports its packages by absolute URL and runs from outside the checkout. */
function baseEslintConfig(pkg) {
	const text = atBase(`${pkg}/eslint.config.mjs`);
	if (!text) return null;
	const from = [pkg, "packages/domain", "apps/web"].map((dir) => createRequire(join(root, dir, "package.json")));
	const rewritten = text.replace(/from "([^"./][^"]*)"/g, (_, spec) => {
		for (const req of from) {
			try {
				return `from ${JSON.stringify(pathToFileURL(req.resolve(spec)).href)}`;
			} catch {}
		}
		throw new Error(`${pkg}: cannot resolve ${spec} for the base ESLint config`);
	});
	const file = join(out, `eslint-base.${pkg.replace("/", "-")}.mjs`);
	writeFileSync(file, rewritten);
	return file;
}

/** The ESLint binary of the package, or of a package that still has one when this one dropped ESLint. */
function eslintBin(pkg) {
	for (const dir of [pkg, "packages/domain", "apps/web"]) {
		const bin = join(root, dir, "node_modules/eslint/bin/eslint.js");
		if (existsSync(bin)) return bin;
	}
	throw new Error("no ESLint install left to time the base config");
}

function lintForms(pkg) {
	const baseScript = scriptOf(pkg, "lint", atBase(`${pkg}/package.json`));
	const headScript = scriptOf(pkg, "lint");
	const config = baseScript && baseEslintConfig(pkg);
	if (!baseScript || !headScript || !config) return null;
	// The base command, with its ESLint pointed at the base config: ESLint takes the working directory as the base
	// path of a --config file, which is the base path the original command had.
	const steps = linterSteps(baseScript).map((step) => {
		if (!/\beslint\b/.test(step)) return step;
		const words = step.split(/\s+/);
		const rest = words.slice(1).filter((word, i, all) => word !== "--config" && all[i - 1] !== "--config");
		return [process.execPath, eslintBin(pkg), "--config", config, ...rest].join(" ");
	});
	return { current: steps.join(" && "), new: linterSteps(headScript).join(" && "), cwd: join(root, pkg) };
}

/** Adds --test-isolation=none to every node or tsx test run in a test:unit script. */
const withoutIsolation = (script) =>
	script.replace(/(\b(?:node|tsx)\b[^&]*?)--test(?![-\w])/g, "$1--test --test-isolation=none");

function isolationForms(pkg) {
	const script = scriptOf(pkg, "test:unit", atBase(`${pkg}/package.json`));
	return script ? { current: script, new: withoutIsolation(script), cwd: join(root, pkg) } : null;
}

/** One timed run: wall time, the peak RSS of the largest process in the tree, and the load when it started. */
async function measure(command, cwd, env) {
	const timeFlag = platform() === "darwin" ? "-l" : "-v";
	const load = loadavg()[0];
	const started = process.hrtime.bigint();
	// Its own process group, so a form that hangs (an open handle with test isolation off) is killed whole at 300 s.
	const child = spawn("/usr/bin/time", [timeFlag, "sh", "-c", command], {
		cwd,
		env: { ...process.env, ...env },
		detached: true,
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-64 * 1024)));
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		process.kill(-child.pid, "SIGKILL");
	}, 300_000);
	const status = await new Promise((done) => child.on("close", (code) => done(code)));
	clearTimeout(timer);
	const seconds = Number(process.hrtime.bigint() - started) / 1e9;
	const rss =
		platform() === "darwin"
			? Number(/(\d+)\s+maximum resident set size/.exec(stderr)?.[1] ?? NaN)
			: Number(/Maximum resident set size \(kbytes\): (\d+)/.exec(stderr)?.[1] ?? NaN) * 1024;
	return {
		seconds,
		peakMb: Math.round(rss / 1024 / 1024),
		load: Number(load.toFixed(2)),
		exit: timedOut ? "timeout" : status,
	};
}

const binPath = (cwd) => [join(cwd, "node_modules/.bin"), join(root, "node_modules/.bin"), process.env.PATH].join(":");

async function timeForms(change, target, forms, prepare = () => {}) {
	const record = { change, target, current: [], new: [], commands: { current: forms.current, new: forms.new } };
	for (let i = 0; i < runs; i++) {
		const order = i % 2 === 0 ? ["current", "new"] : ["new", "current"];
		for (const form of order) {
			const restore = prepare(form);
			try {
				const run = await measure(forms[form], forms.cwd, { PATH: binPath(forms.cwd), NEXT_TELEMETRY_DISABLED: "1" });
				record[form].push(run);
				console.log(
					`${change} ${target} ${form} run ${i + 1}: ${run.seconds.toFixed(2)} s, ${run.peakMb} MB, load ${run.load}, exit ${run.exit}`,
				);
			} finally {
				restore?.();
			}
		}
	}
	return record;
}

const results = [];
const only = new Set(args.only.split(","));

if (only.has("lint"))
	for (const pkg of lintPackages) {
		const forms = lintForms(pkg);
		if (forms) results.push(await timeForms("lint", pkg, forms));
	}

if (only.has("build")) {
	// The build runs as `pnpm check` and the CI app job run it: after `tsc --noEmit` (untimed), with .next/cache kept.
	// The current form builds with the base-ref next.config.ts in place; the file is restored after each run.
	const web = join(root, "apps/web");
	const configPath = join(web, "next.config.ts");
	const baseConfig = atBase("apps/web/next.config.ts");
	const prepare = (form) => {
		for (const entry of existsSync(join(web, ".next")) ? readdirSync(join(web, ".next")) : [])
			if (args.cold || entry !== "cache") rmSync(join(web, ".next", entry), { recursive: true, force: true });
		execFileSync(join(web, "node_modules/.bin/tsc"), ["--noEmit"], { cwd: web, stdio: "ignore" });
		if (form !== "current") return;
		const backup = join(out, "next.config.ts.working");
		cpSync(configPath, backup);
		writeFileSync(configPath, baseConfig + "\n");
		return () => cpSync(backup, configPath);
	};
	results.push(
		await timeForms(
			args.cold ? "build (cold)" : "build",
			"apps/web",
			{ current: "next build", new: "next build", cwd: web },
			prepare,
		),
	);
}

if (only.has("isolation"))
	for (const pkg of lintPackages) {
		const forms = isolationForms(pkg);
		if (forms) results.push(await timeForms("isolation", pkg, forms));
	}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const summarize = (r) => {
	const cur = median(r.current.map((x) => x.seconds));
	const neu = median(r.new.map((x) => x.seconds));
	const loads = [...r.current, ...r.new].map((x) => x.load);
	return {
		...r,
		medianSeconds: { current: cur, new: neu },
		medianPeakMb: { current: median(r.current.map((x) => x.peakMb)), new: median(r.new.map((x) => x.peakMb)) },
		load: { min: Math.min(...loads), max: Math.max(...loads) },
		saving: 1 - neu / cur,
		failed: [...r.current, ...r.new].some((x) => x.exit !== 0),
	};
};
const rows = results.map(summarize);

const lines = [
	`Timing on ${cpus().length} CPUs, ${runs} runs per form, base ${base.slice(0, 8)}, head ${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain") ? " plus working-tree changes" : ""}.`,
	"",
	"| Change | Target | Current median s | New median s | Saving | Current peak MB | New peak MB | 1-min load | Runs (current / new, s) |",
	"|---|---|---:|---:|---:|---:|---:|---|---|",
];
const fmt = (xs) => xs.map((x) => x.seconds.toFixed(1) + (x.exit ? "!" : "")).join(" ");
for (const r of rows)
	lines.push(
		`| ${r.change} | ${r.target} | ${r.medianSeconds.current.toFixed(2)} | ${r.medianSeconds.new.toFixed(2)} | ${(r.saving * 100).toFixed(0)}% | ${r.medianPeakMb.current} | ${r.medianPeakMb.new} | ${r.load.min} to ${r.load.max} | ${fmt(r.current)} / ${fmt(r.new)} |`,
	);
for (const change of new Set(rows.map((r) => r.change))) {
	const group = rows.filter((r) => r.change === change);
	const cur = group.reduce((sum, r) => sum + r.medianSeconds.current, 0);
	const neu = group.reduce((sum, r) => sum + r.medianSeconds.new, 0);
	lines.push(
		`| ${change} | all, summed | ${cur.toFixed(2)} | ${neu.toFixed(2)} | ${((1 - neu / cur) * 100).toFixed(0)}% | | | | |`,
	);
}
lines.push("", "A run marked ! exited non-zero or hit the 300 s limit.");
writeFileSync(join(out, "results.json"), JSON.stringify(rows, null, 2) + "\n");
writeFileSync(join(out, "results.md"), lines.join("\n") + "\n");
console.log("\n" + lines.join("\n") + `\n\nWritten to ${out}`);
