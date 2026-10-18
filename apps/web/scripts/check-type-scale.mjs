// Fails when a public-site font size is off the type scale. The scale is the dashboard's: the --ef-text-*, --ef-title-*
// and --ef-display-* sizes in design/handoff/tokens.css, plus the three named marketing sizes in src/styles/marketing.css.
// Components set sizes with type-* (size only) or text-* scale utilities; no px, rem, em, vw or clamp() sizes, no
// Tailwind sizes off the scale and no inline font sizes. Run from apps/web: `node scripts/check-type-scale.mjs`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const TOKENS = readFileSync(here("../../../design/handoff/tokens.css"), "utf8");
const SCALE = new Set([...TOKENS.matchAll(/--ef-(?:text|title|display)-[a-z]+:\s*(\d+)px;/g)].map((m) => Number(m[1])));
// The named sizes off the scale and the only places their values may be written.
const NAMED = { "--text-mk-display-xl": 88, "--text-mk-pic-xs": 11, "--text-mk-pic-2xs": 10 };
// Picture sizes belong to the miniature product pictures, never to page text.
const PICTURE_DIRS = ["marketing/", "components/kit/"];
const NAMES = new Set([
	...[...TOKENS.matchAll(/^\s*--text-([a-z-]+?):/gm)].map((m) => m[1]).filter((n) => !n.endsWith("-line-height")),
	...[...readFileSync(here("../src/styles/marketing.css"), "utf8").matchAll(/^\s*--text-(mk-[a-z0-9-]+?):/gm)]
		.map((m) => m[1])
		.filter((n) => !n.endsWith("-line-height")),
]);

const SRC = here("../src");
// Public site sources. The sign-in screens (WP-005) and the product design preview are not the public site.
const SKIP = ["app/(identity)/", "app/design/", "features/"];
const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
	);

const found = [];
const report = (where, what) => found.push(`${where}: ${what}`);

// A size in a Tailwind arbitrary value: text-[15px], text-[clamp(...)], text-[1.2em], text-[smaller], text-(length:--x).
const ARBITRARY = /(?<![\w-])text-(?:\[(?!var\(|color-mix\(|#)[^\]\s]*\]|\(length:[^)]*\))/g;
// Tailwind's default sizes that are not on the scale (its xs, sm and lg are redefined by tokens.css).
const DEFAULT = /(?<![\w-])text-(?:base|[2-9]?xl)(?![\w-])/g;
// type-* sets a size only; every name must be a type token. Picture sizes are checked on both type-* and text-*.
const TYPE = /(?<![\w-])type-([a-z0-9-]+)/g;
const PICTURE = /(?<![\w-])(?:type|text)-mk-pic-[a-z0-9]+/g;
const INLINE = /fontSize|font-size|\[font-size:/g;

for (const file of walk(SRC).filter((f) => /\.tsx?$/.test(f))) {
	const rel = file.slice(SRC.length + 1);
	if (SKIP.some((s) => rel.startsWith(s))) continue;
	readFileSync(file, "utf8")
		.split("\n")
		.forEach((line, i) => {
			const where = `src/${rel}:${i + 1}`;
			for (const re of [ARBITRARY, DEFAULT, INLINE]) for (const m of line.matchAll(re)) report(where, m[0]);
			for (const m of line.matchAll(TYPE)) if (!NAMES.has(m[1])) report(where, `${m[0]} is not a type token`);
			if (!PICTURE_DIRS.some((d) => rel.startsWith(d)))
				for (const m of line.matchAll(PICTURE)) report(where, `${m[0]} is for miniature product pictures only`);
		});
}

// CSS and the share-image renderer: every font size is a scale variable or a whole pixel on the scale. Each line can
// hold several declarations, so every one is checked; the font shorthand may only pass a size through a variable.
const DECL = /(?:^|[\s;{])(font-size|font|--text-[a-z0-9-]+)\s*:\s*([^;}]+)/g;
const checkCss = (label, text, extra) =>
	text.split("\n").forEach((line, i) => {
		for (const [, prop, raw] of line.matchAll(DECL)) {
			if (prop.endsWith("--line-height")) continue;
			const value = raw.trim();
			if (/^(?:var\(--(?:ef|text)-[a-z0-9-]+\)|--value\(--text-\*\))$/.test(value)) continue;
			if (prop === "font" && /^(?:inherit|initial|unset|revert|var\([^)]*\))$/.test(value)) continue;
			const px = value.match(/^(\d+)px$/);
			if (prop !== "font" && px) {
				const n = Number(px[1]);
				if (SCALE.has(n) || NAMED[prop] === n || extra.has(n)) continue;
			}
			report(`${label}:${i + 1}`, `${prop}: ${value}`);
		}
	});
for (const file of walk(SRC).filter((f) => f.endsWith(".css"))) {
	const rel = file.slice(SRC.length + 1);
	if (!SKIP.some((s) => rel.startsWith(s))) checkCss(`src/${rel}`, readFileSync(file, "utf8"), new Set());
}
// A share image may use the named hero size; it is a 1200 px picture of the hero.
checkCss("scripts/render-share-images.mjs", readFileSync(here("./render-share-images.mjs"), "utf8"), new Set([88]));

if (found.length) {
	console.error(
		`Font sizes off the type scale (${[...SCALE].join(", ")} px; use a type-* or text-* token, see src/styles/marketing.css):\n${found.join("\n")}`,
	);
	process.exit(1);
}
