import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { root } from "../../../scripts/lint/ratchet.mjs";
import { cssProblems, message } from "../../../scripts/lint/slop-styling.mjs";

const ROOTS = ["apps/web/src/features", "packages/ui/src", "apps/web/src/marketing"];
const FILES = ["apps/web/src/styles/marketing.css"];

const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
	);
const files = [
	...ROOTS.flatMap((dir) => (existsSync(join(root, dir)) ? walk(join(root, dir)) : [])).filter((f) =>
		f.endsWith(".css"),
	),
	...FILES.map((path) => join(root, path)).filter((file) => existsSync(file)),
];
const found = [];
for (const file of files) {
	const path = relative(root, file).split("\\").join("/");
	for (const p of cssProblems(readFileSync(file, "utf8"), path))
		found.push(`${path}:${p.line}: ${p.selector}: ${message(p.kind, p.token)}`);
}
if (found.length) {
	console.error(`AI-slop styling in CSS:\n${found.join("\n")}`);
	process.exit(1);
}
