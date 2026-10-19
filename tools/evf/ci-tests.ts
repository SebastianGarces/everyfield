import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fail } from "./lib.ts";

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
	function follow(command: string, pkg: Package): void {
		for (const part of command.split(/\s*(?:&&|\|\||;|\n)\s*/)) {
			const tokens = (part.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((t) => t.replace(/^(['"])(.*)\1$/, "$2"));
			if (tokens[0] === "corepack") tokens.shift();
			if (tokens[0] === "pnpm") {
				const args = tokens.slice(1);
				const filterAt = args.indexOf("--filter"),
					filter = filterAt < 0 ? undefined : args.splice(filterAt, 2)[1];
				const recursive = args.includes("-r") || args.includes("--recursive");
				const script = args.filter((t) => !t.startsWith("-") && t !== "run")[0];
				const targets = filter
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
			} else if (["node", "tsx"].includes(tokens[0]) && tokens.includes("--test")) {
				for (const token of tokens.slice(tokens.indexOf("--test") + 1)) {
					if (!/\.test\.(?:mts|ts)$/.test(token)) continue;
					for (const file of globSync(token, { cwd: resolve(root, pkg.dir) }))
						covered.add(relative(root, resolve(root, pkg.dir, file)));
				}
			}
		}
	}
	const workflow = join(root, ".github/workflows/ci.yml");
	if (!existsSync(workflow)) fail("CI test coverage requires .github/workflows/ci.yml.");
	// Only CI's run steps count. Resolve each job's default directory and any step override.
	for (const job of readFileSync(workflow, "utf8").split(/(?=^  [\w-]+:\s*$)/m)) {
		const defaultDir = job.match(/^    defaults:\n      run:\n        working-directory:\s*(.+)$/m)?.[1] ?? ".";
		for (const step of job.split(/(?=^      - )/m).slice(1)) {
			const dir = step.match(/^        working-directory:\s*(.+)$/m)?.[1] ?? defaultDir;
			const pkg = packages.find((p) => p.dir === dir) ?? { dir, name: "", scripts: {} };
			const lines = step.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const match = lines[i].match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
				if (!match) continue;
				let command = match[2];
				if (/^[|>][-+]?\s*$/.test(command)) {
					command = "";
					while (i + 1 < lines.length && (!lines[i + 1].trim() || lines[i + 1].search(/\S/) > match[1].length))
						command += lines[++i].trim() + "\n";
				}
				follow(command, pkg);
			}
		}
	}
	const files = globSync(["tests/integration/**/*.test.mts", "packages/*/test/**/*.test.mts"], { cwd: root }).sort();
	const exceptionFile = join(root, "tools/evf/ci-test-exceptions.json");
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
