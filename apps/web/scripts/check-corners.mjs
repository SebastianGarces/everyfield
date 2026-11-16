import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOTS = [
	["../../../packages/ui/src", "packages/ui/src"],
	["../src/features", "apps/web/src/features"],
	["../src/app/(product)", "apps/web/src/app/(product)"],
].map(([path, label]) => [fileURLToPath(new URL(path, import.meta.url)), label]);
const FIXED = /\brounded(?:-(?:t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee))?-\[\d[^\]]*\]/;

const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
	);
const found = [];
for (const [root, label] of ROOTS)
	for (const file of walk(root).filter((f) => /\.tsx?$/.test(f)))
		readFileSync(file, "utf8")
			.split("\n")
			.forEach((line, i) => {
				const m = line.match(FIXED);
				if (m) found.push(`${label}/${file.slice(root.length + 1)}:${i + 1}: ${m[0]}`);
			});
if (found.length) {
	console.error(
		`Fixed-pixel corners (use rounded-md, rounded-card or rounded-pill, which read --corner-*):\n${found.join("\n")}`,
	);
	process.exit(1);
}
