// Which tool enforces each lint rule the packages had on before Oxlint took its share (T-43).
//
//   node scripts/lint-rule-coverage.mjs                  prints the coverage list
//   node scripts/lint-rule-coverage.mjs --write-baseline records the rules on in the ESLint configs, without the
//                                                         eslint-plugin-oxlint layer, in tests/workflow/lint-rules-baseline.json
//
// The baseline holds every rule that was on for at least one file each package lints. After the change a rule is
// enforced by ESLint when it is still on there for some file, or by Oxlint when the package's .oxlintrc.json turns it
// on (read through eslint-plugin-oxlint, which maps Oxlint's rules to their ESLint names). Anything else is missing,
// and tests/workflow/lint-rule-coverage.test.mjs fails on it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const baselineFile = join(root, "tests/workflow/lint-rules-baseline.json");
const lintable = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const severities = { 0: "off", 1: "warn", 2: "error", off: "off", warn: "warn", error: "error" };

// Oxlint runs the React compiler with fixed, valid options. These two rules only report invalid compiler options and
// an invalid gating setup, both read from the rule's options, so they have nothing to check when the old config gave
// them none and Oxlint runs the compiler rules in their place.
const compilerOptionRules = ["react-hooks/config", "react-hooks/gating"];

export const packages = () => ["apps/web", ...readdirSync(join(root, "packages")).map((name) => `packages/${name}`)];

/** Reads a package's lint script: where it runs and what its ESLint and Oxlint steps lint. */
function lintSetup(pkg) {
	const script = JSON.parse(readFileSync(join(root, pkg, "package.json"), "utf8")).scripts?.lint;
	if (!script) return null;
	const steps = script.split(" && ");
	const fromRoot = steps[0] === "cd ../..";
	const cwd = fromRoot ? root : join(root, pkg);
	const step = (tool) => {
		const words = steps.find((s) => new RegExp(`(^|/)${tool}\\b`).test(s.split(/\s+/)[0]))?.split(/\s+/);
		if (!words) return null;
		const flag = words.findIndex((w) => w === "--config" || w === "-c");
		const config = flag === -1 ? null : resolve(cwd, words[flag + 1]);
		const paths = words.filter((w, i) => i > 0 && !w.startsWith("-") && (flag === -1 || i !== flag + 1));
		return { config, paths };
	};
	const eslint = step("eslint");
	const oxlint = step("oxlint");
	if (eslint) eslint.config ??= join(root, pkg, "eslint.config.mjs");
	if (oxlint) oxlint.config ??= join(root, pkg, ".oxlintrc.json");
	return { cwd, eslint, oxlint };
}

const requireFrom = (pkg, name) => {
	for (const dir of [pkg, "apps/web", "packages/domain"]) {
		try {
			return createRequire(join(root, dir, "package.json"))(name);
		} catch {}
	}
	throw new Error(`cannot load ${name} for ${pkg}`);
};

/** The rules on for at least one linted file, each with its strictest severity and the options it had. */
async function eslintRules(pkg, setup, { withoutOxlint }) {
	const { ESLint } = requireFrom(pkg, "eslint");
	let config = (await import(pathToFileURL(setup.eslint.config).href)).default;
	config = (await config).flat();
	if (withoutOxlint) config = config.filter((entry) => !entry.name?.startsWith("oxlint/"));
	// The working directory is the base path ESLint gives a config, as the lint script runs it.
	const eslint = new ESLint({ cwd: setup.cwd, overrideConfigFile: true, baseConfig: config });
	const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", ...setup.eslint.paths], {
		cwd: setup.cwd,
		encoding: "utf8",
	})
		.split("\n")
		.filter((file) => file && lintable.has(extname(file)) && existsSync(join(setup.cwd, file)));
	const rules = {};
	for (const file of files) {
		if (await eslint.isPathIgnored(join(setup.cwd, file))) continue;
		const computed = await eslint.calculateConfigForFile(join(setup.cwd, file));
		for (const [rule, value] of Object.entries(computed?.rules ?? {})) {
			const [level, ...options] = Array.isArray(value) ? value : [value];
			const severity = severities[level];
			if (severity === "off") continue;
			const seen = rules[rule];
			if (!seen || (seen.severity === "warn" && severity === "error")) rules[rule] = { severity, options };
		}
	}
	return Object.fromEntries(Object.entries(rules).sort(([a], [b]) => a.localeCompare(b)));
}

/** The ESLint names of the rules a package's Oxlint config turns on. */
function oxlintRules(pkg, setup) {
	if (!setup.oxlint) return new Set();
	const { buildFromOxlintConfigFile } = requireFrom(pkg, "eslint-plugin-oxlint");
	return new Set(buildFromOxlintConfigFile(setup.oxlint.config).flatMap((entry) => Object.keys(entry.rules ?? {})));
}

export async function writeBaseline() {
	const baseline = {};
	for (const pkg of packages()) {
		const setup = lintSetup(pkg);
		if (setup?.eslint && existsSync(setup.eslint.config))
			baseline[pkg] = await eslintRules(pkg, setup, { withoutOxlint: true });
	}
	writeFileSync(baselineFile, JSON.stringify(baseline, null, "\t") + "\n");
	return baseline;
}

/** For each package, each baseline rule and the tool that enforces it now: "eslint", "oxlint" or "missing". */
export async function coverage(baseline = JSON.parse(readFileSync(baselineFile, "utf8"))) {
	const result = {};
	for (const [pkg, oldRules] of Object.entries(baseline)) {
		const setup = lintSetup(pkg);
		const eslint =
			setup?.eslint && existsSync(setup.eslint.config) ? await eslintRules(pkg, setup, { withoutOxlint: false }) : {};
		const oxlint = setup ? oxlintRules(pkg, setup) : new Set();
		const runsCompiler = oxlint.has("react-hooks/static-components");
		result[pkg] = Object.entries(oldRules).map(([rule, { severity, options }]) => {
			let tool = "missing";
			if (rule in eslint) tool = "eslint";
			else if (oxlint.has(rule)) tool = "oxlint";
			else if (compilerOptionRules.includes(rule) && runsCompiler && options.length === 0)
				tool = "oxlint (fixed compiler options)";
			return { rule, severity, tool };
		});
	}
	return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--write-baseline")) {
		const baseline = await writeBaseline();
		console.log(`Wrote ${relative(root, baselineFile)}: ${Object.keys(baseline).length} packages.`);
	} else {
		const result = await coverage();
		let missing = 0;
		for (const [pkg, rows] of Object.entries(result)) {
			console.log(`\n### ${pkg}\n\n| Rule | Old severity | Enforced by |\n|---|---|---|`);
			for (const row of rows) {
				console.log(`| ${row.rule} | ${row.severity} | ${row.tool} |`);
				if (row.tool === "missing") missing++;
			}
		}
		if (missing) {
			console.error(`\n${missing} rule(s) on in the old ESLint config are in neither tool.`);
			process.exitCode = 1;
		}
	}
}
