import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { area, readSurvivors, root } from "../../../scripts/lint/ratchet.mjs";
import { cssProblems, message } from "../../../scripts/lint/slop-styling.mjs";

const RULE = "no-slop-styling";
const ROOTS = ["apps/web/src/features", "packages/ui/src"];

const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
	);
const survivors = readSurvivors()[RULE] ?? {};
const found = [];
for (const dir of ROOTS)
	for (const file of walk(join(root, dir)).filter((f) => f.endsWith(".css"))) {
		const path = relative(root, file).split("\\").join("/");
		let rest = cssProblems(readFileSync(file, "utf8"));
		for (const entry of survivors[path] ?? []) {
			const inside = rest.filter((p) => p.selector === entry.function);
			const kept = inside.slice(0, entry.count);
			rest = rest.filter((p) => !kept.includes(p));
			if (kept.length < entry.count)
				found.push(
					`${path}: ${entry.function} has ${kept.length} ${RULE} hits, fewer than its survivor entry allows (${entry.count}): lower or delete the entry in scripts/lint/survivors/${area(path)}.json`,
				);
		}
		for (const p of rest) found.push(`${path}:${p.line}: ${p.selector}: ${message(p.kind, p.token)}`);
	}
if (found.length) {
	console.error(
		`AI-slop styling in CSS (a real exception is a survivor in scripts/lint/survivors/<area>.json whose "function" is the selector):\n${found.join("\n")}`,
	);
	process.exit(1);
}
