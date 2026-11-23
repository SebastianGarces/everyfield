import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registry, type Registry } from "../../packages/domain/src/flags/registry.ts";

const SOURCE_GLOBS = ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"];
const NOT_READERS = [
	"packages/domain/src/flags/",
	"apps/web/src/server/flags.ts",
	"apps/web/src/server/flags.types.ts",
];

export type Source = { path: string; text: string };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const reads = (name: string) =>
	new RegExp(`(?:\\breadFlag\\s*\\(|\\.value\\s*\\()\\s*(["'\`])${escape(name)}\\1\\s*\\)`);

export function flagProblems(declared: Registry, sources: readonly Source[], today: string): string[] {
	const readers = sources.filter(
		(s) => !NOT_READERS.some((p) => s.path === p || (p.endsWith("/") && s.path.startsWith(p))),
	);
	const problems: string[] = [];
	for (const [name, flag] of Object.entries(declared)) {
		if (flag.kind === "release" && Date.parse(flag.expires) < Date.parse(today))
			problems.push(
				`release flag ${name} expired on ${flag.expires} (owner ${flag.owner}, ${flag.task}): remove it, or move expires in packages/domain/src/flags/registry.ts with the owner's word`,
			);
		if (!readers.some((s) => reads(name).test(s.text)))
			problems.push(
				`flag ${name} has no reader left: no readFlag("${name}") outside the registry and flag declarations, so delete its registry entry`,
			);
	}
	return problems;
}

export function repoSources(root: string): Source[] {
	return SOURCE_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: root, exclude: (p) => p.includes("node_modules") }))
		.sort()
		.map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
}

const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

export function checkCommand(root: string, out = console.log, err = console.error): number {
	const problems = flagProblems(registry, repoSources(root), todayUtc());
	if (problems.length) {
		for (const p of problems) err(`flag check: ${p}`);
		return 1;
	}
	const count = Object.keys(registry).length;
	out(`flag check: ${count} flag${count === 1 ? "" : "s"}, no release flag past expires, every flag has a reader.`);
	return 0;
}
