import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const UI = fileURLToPath(new URL("../../../packages/ui/src", import.meta.url));
const HEX = /(?<![0-9A-Za-z&])#[0-9A-Fa-f]{3,8}(?![0-9A-Za-z])/;
const FN =
	/(?<![A-Za-z-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*(?:[\d.+-]|from(?![A-Za-z])|var\(|none(?![A-Za-z]))/i;
const ALLOWED = {
	"app/viewport.ts": "the theme-color meta tag (Next viewport metadata) takes a literal colour",
	"app/apple-icon.tsx": "next/og renders the icon without the page's CSS, so it cannot read a variable",
	"features/settings/brand/BrandSection.tsx": "the native color input needs a hex value while the typed color is empty",
	"features/settings/brand/fixtures.ts":
		"the design-preview fixture holds a church's saved brand colors, which are data, not design colors",
};

const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
	);
const found = [];
for (const [root, label] of [
	[SRC, "src"],
	[UI, "packages/ui/src"],
]) {
	for (const file of walk(root).filter((f) => /\.tsx?$/.test(f))) {
		const rel = file.slice(root.length + 1);
		if (root === SRC && rel in ALLOWED) continue;
		readFileSync(file, "utf8")
			.split("\n")
			.forEach((line, i) => {
				const m = line.match(HEX) ?? line.match(FN);
				if (m) found.push(`${label}/${rel}:${i + 1}: ${m[0]}`);
			});
	}
}
if (found.length) {
	console.error(
		`Colour literals in components (use a token from tokens.css, the marketing layer of marketing.css or product.css):\n${found.join("\n")}`,
	);
	process.exit(1);
}
