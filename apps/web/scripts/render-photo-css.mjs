// Writes src/styles/photos.generated.css from src/marketing/photo/photos.json: one --photo-<name> source per photo and
// one [data-photo] crop rule per photo. Run from apps/web: `node scripts/render-photo-css.mjs`; `--check` exits 1 when
// the CSS is out of date.
//
// Why CSS and not <img>: a slot is one <span data-photo> in the HTML and in the RSC payload, and the file URLs live once
// in the shared stylesheet. Srcset markup for about 30 photo layers per page made the HTML 5 KB larger (gzip) and cost
// 150 ms of simulated FCP on phones. Files: the small copy by default; the large copy on wide screens at 2x and above.
// AVIF where image-set() with type() works (an unsupported type() in a variable invalidates the whole background in
// Safari before 17), JPEG otherwise.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const photos = JSON.parse(readFileSync(here("../src/marketing/photo/photos.json"), "utf8"));
const OUT = here("../src/styles/photos.generated.css");
const names = Object.keys(photos);
const jpg = (f) => `url("/photos/${f}.jpg")`;
const set = (f) => `image-set(url("/photos/${f}.avif") type("image/avif"), ${jpg(f)} type("image/jpeg"))`;
const vars = (size, src) => names.map((n) => `\t--photo-${n}: ${src(photos[n][size])};`).join("\n");
const LARGE = "(min-width: 901px) and (min-resolution: 2dppx)";
const css = `/* Written by scripts/render-photo-css.mjs from src/marketing/photo/photos.json. Do not edit. */
:root {
${vars("small", jpg)}
}
@media ${LARGE} {
	:root {
${vars("large", jpg).replace(/^/gm, "\t")}
	}
}
@supports (background-image: image-set(url("/photos/glow-600.avif") type("image/avif"))) {
	:root {
${vars("small", set).replace(/^/gm, "\t")}
	}
	@media ${LARGE} {
		:root {
${vars("large", set).replace(/^/gm, "\t\t")}
		}
	}
}
${names
	.map((n) => {
		const p = photos[n];
		const extra = (p.zoom ? ` --zoom: ${p.zoom};` : "") + (p.shade ? ` --shade: ${p.shade};` : "");
		return `[data-photo="${n}"] {\n\t--photo-src: var(--photo-${n});\n\t--pos: ${p.pos};${extra ? "\n\t" + extra.trim().replace(/; /g, ";\n\t") : ""}\n}`;
	})
	.join("\n")}
`;
if (process.argv.includes("--check")) {
	let cur = "";
	try {
		cur = readFileSync(OUT, "utf8");
	} catch {
		/* missing */
	}
	if (cur !== css) {
		console.error("src/styles/photos.generated.css is out of date. Run: node scripts/render-photo-css.mjs");
		process.exit(1);
	}
	process.exit(0);
}
writeFileSync(OUT, css);
console.log("photos.generated.css:", names.length, "photos");
