import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { root } from "../../../scripts/lint/ratchet.mjs";
import { cssProblems, message } from "../../../scripts/lint/slop-styling.mjs";

const ROOTS = ["apps/web/src/features", "packages/ui/src"];

const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
	);
const found = [];
for (const dir of ROOTS)
	for (const file of walk(join(root, dir)).filter((f) => f.endsWith(".css"))) {
		const path = relative(root, file).split("\\").join("/");
		for (const p of cssProblems(readFileSync(file, "utf8")))
			found.push(`${path}:${p.line}: ${p.selector}: ${message(p.kind, p.token)}`);
	}
if (found.length) {
	console.error(`AI-slop styling in CSS:\n${found.join("\n")}`);
	process.exit(1);
}
