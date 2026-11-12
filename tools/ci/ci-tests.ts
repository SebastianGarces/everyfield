import { existsSync, globSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";

/** A refusal to show as one line, with no stack trace. */
class CiTestsError extends Error {
	name = "ToolError";
}

function fail(message: string): never {
	throw new CiTestsError(message);
}

type Package = { dir: string; name: string; scripts: Record<string, string> };

/** Follow the CI script graph and expand its test paths, so fixed file lists cannot silently omit a new suite. */
export function checkCiTests(root: string): void {
	const packages: Package[] = [
		"package.json",
		...globSync(["packages/*/package.json", "apps/*/package.json"], { cwd: root }),
	].map((file) => {
		const pkg: unknown = JSON.parse(readFileSync(join(root, file), "utf8"));
		if (
			!pkg ||
			typeof pkg !== "object" ||
			!("scripts" in pkg) ||
			!pkg.scripts ||
			typeof pkg.scripts !== "object" ||
			Array.isArray(pkg.scripts)
		)
			fail(`${file} needs a scripts object for CI test coverage.`);
		const scripts: Record<string, string> = {};
		for (const [name, command] of Object.entries(pkg.scripts)) {
			if (typeof command !== "string") fail(`${file} script ${name} must be a string.`);
			scripts[name] = command;
		}
		return { dir: dirname(file), name: "name" in pkg && typeof pkg.name === "string" ? pkg.name : "", scripts };
	});
	const covered = new Set<string>(),
		visited = new Set<string>();
	function follow(command: string, pkg: Package, matrix: Record<string, string[]> = {}): void {
		for (const part of command.split(/\s*(?:&&|\|\||;|\n)\s*/)) {
			const tokens = (part.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((t) => t.replace(/^(['"])(.*)\1$/, "$2"));
			if (tokens[0] === "corepack") tokens.shift();
			if (tokens[0] === "pnpm") {
				const args = tokens.slice(1);
				const filterAt = args.indexOf("--filter"),
					filter = filterAt < 0 ? undefined : args.splice(filterAt, 2)[1];
				const recursive = args.includes("-r") || args.includes("--recursive");
				const script = args.filter((t) => !t.startsWith("-") && t !== "run")[0];
				if (script === undefined) continue;
				const axis = filter?.match(/^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/)?.[1];
				if (axis) {
					// A matrix over package names replaces `pnpm -r --if-present`: it must list every package with the script.
					const names = matrix[axis] ?? [];
					const missing = packages.filter((p) => p.dir !== "." && p.scripts[script] && !names.includes(p.name));
					const unknown = names.filter((name) => !packages.some((p) => p.name === name));
					if (!names.length || missing.length || unknown.length)
						fail(
							`ci.yml runs ${script} for each matrix.${axis}, which must list exactly the packages that define it. Missing: ${missing.map((p) => p.name).join(", ") || "none"}. Unknown: ${unknown.join(", ") || "none"}.`,
						);
				}
				const targets = axis
					? packages.filter((p) => (matrix[axis] ?? []).includes(p.name))
					: filter
						? packages.filter((p) => p.name === filter)
						: recursive
							? packages.filter((p) => p.dir !== ".")
							: [pkg];
				for (const target of targets) {
					const key = `${target.dir}:${script}`;
					if (!target.scripts[script] || visited.has(key)) continue;
					visited.add(key);
					follow(target.scripts[script], target);
				}
			} else if (["node", "tsx"].includes(tokens[0] ?? "") && tokens.includes("--test")) {
				for (const token of tokens.slice(tokens.indexOf("--test") + 1)) {
					if (!/\.(?:test\.(?:mts|ts|mjs)|db\.mts)$/.test(token)) continue;
					for (const file of globSync(token, { cwd: resolve(root, pkg.dir) })) {
						covered.add(relative(root, resolve(root, pkg.dir, file)));
						// The write budget harness executes exactly the same checked-in suite manifest.
						if (relative(root, resolve(root, pkg.dir, file)) === "tests/integration/writes/statements.test.mts") {
							const manifest: unknown = JSON.parse(
								readFileSync(join(root, "tests/integration/writes/suites.json"), "utf8"),
							);
							if (
								!Array.isArray(manifest) ||
								!manifest.every((p) => typeof p === "string" && !p.startsWith("/") && !p.includes(".."))
							)
								fail("Write census suite paths must stay inside the repository.");
							for (const pattern of manifest)
								for (const nested of globSync(pattern, { cwd: root })) covered.add(nested);
						}
					}
				}
			}
		}
	}
	const workflow = join(root, ".github/workflows/ci.yml");
	if (!existsSync(workflow)) fail("CI test coverage requires .github/workflows/ci.yml.");
	// Only CI's run steps count. Resolve each job's default directory and any step override.
	for (const job of readFileSync(workflow, "utf8").split(/(?=^  [\w-]+:\s*$)/m)) {
		const defaultDir = job.match(/^    defaults:\n      run:\n        working-directory:\s*(.+)$/m)?.[1] ?? ".";
		// Matrix values, from `key: value` lines (plain or `- key: value` include entries) under `matrix:`.
		const matrix: Record<string, string[]> = {};
		for (const [, key, value] of (job.split(/^\s+matrix:\s*$/m)[1]?.split(/^    \S/m)[0] ?? "").matchAll(
			/^\s+(?:-\s+)?([\w-]+):\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/gm,
		))
			(matrix[key!] ??= []).push(value!);
		for (const step of job.split(/(?=^      - )/m).slice(1)) {
			const dir = step.match(/^        working-directory:\s*(.+)$/m)?.[1] ?? defaultDir;
			const pkg = packages.find((p) => p.dir === dir) ?? { dir, name: "", scripts: {} };
			const lines = step.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const match = lines[i]!.match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
				if (!match) continue;
				let command = match[2]!;
				if (/^[|>][-+]?\s*$/.test(command)) {
					command = "";
					while (i + 1 < lines.length && (!lines[i + 1]!.trim() || lines[i + 1]!.search(/\S/) > match[1]!.length))
						command += lines[++i]!.trim() + "\n";
				}
				follow(command, pkg, matrix);
			}
		}
	}
	// A database suite reaches CI only through its package's test:db script: each package that defines one needs a step.
	const unrun = packages.filter((p) => p.dir !== "." && p.scripts["test:db"] && !visited.has(`${p.dir}:test:db`));
	if (unrun.length)
		fail(`ci.yml runs no test:db for ${unrun.map((p) => p.name || p.dir).join(", ")}. Add a step to the db job.`);
	// Browser suites, the tests/ui files that import tests/ui/setup.mjs, run nightly and in the verifier's preview.
	const browserSuite = (file: string) =>
		[...readFileSync(join(root, file), "utf8").matchAll(/\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)].some(
			([, spec]) => relative(root, resolve(root, dirname(file), spec!)) === "tests/ui/setup.mjs",
		);
	const files = [
		...globSync(
			["tests/{integration,evry,reference,contracts}/**/*.{test,db}.mts", "packages/*/{src,test}/**/*.test.{ts,mts}"],
			{ cwd: root },
		),
		...globSync("tests/ui/**/*.test.{mjs,mts}", { cwd: root }).filter((file) => !browserSuite(file)),
	].sort();
	const exceptionFile = join(root, "tools/ci/ci-test-exceptions.json");
	const exceptions = new Set<string>();
	if (existsSync(exceptionFile)) {
		const entries: unknown = JSON.parse(readFileSync(exceptionFile, "utf8"));
		if (!entries || typeof entries !== "object" || Array.isArray(entries))
			fail("CI exceptions must be an object keyed by exact test paths.");
		for (const [file, value] of Object.entries(entries)) {
			const entry: unknown = value;
			if (
				!entry ||
				typeof entry !== "object" ||
				!("reason" in entry) ||
				typeof entry.reason !== "string" ||
				!entry.reason.trim() ||
				!("command" in entry) ||
				typeof entry.command !== "string" ||
				!entry.command.trim()
			)
				fail(`CI exception ${file} needs a reason and local verification command.`);
			if (!files.includes(file) || covered.has(file)) fail(`Remove stale CI exception: ${file}.`);
			exceptions.add(file);
			console.log(`LOCAL ONLY ${file}: ${entry.reason} Run: ${entry.command}`);
		}
	}
	const missing = files.filter((f) => !covered.has(f) && !exceptions.has(f));
	if (missing.length)
		fail(
			`Tests missing from CI commands:\n${missing.join("\n")}\nAdd them to a CI test command or replace a fixed list with a glob.`,
		);
	console.log(
		`CI includes all ${files.length - exceptions.size} test files${exceptions.size ? `; ${exceptions.size} explicit local-only exceptions` : ""}.`,
	);
}

// CI's own check: `node tools/ci/ci-tests.ts` from anywhere in the checkout.
if (import.meta.main) {
	try {
		const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
		if (top.status !== 0) fail("ci-tests must run inside the repository.");
		checkCiTests(top.stdout.trim());
	} catch (error) {
		if (!(error instanceof CiTestsError)) throw error;
		console.error(`ci-tests: ${error.message}`);
		process.exitCode = 1;
	}
}
