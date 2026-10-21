// Writes the small hero copies of the blurred hero photos. Run from apps/web: `node scripts/render-hero-photos.mjs`.
// - src/marketing/photo/hero-photos.generated.ts: each hero as a 480 px AVIF data URI (about 6 to 7 KB), inlined in the page.
// - public/photos/<name>-640.jpg: the fallback for browsers without AVIF.
//
// Why: the hero photo is the page's LCP element. Inline, it needs no request of its own, so it does not share the first
// round trips with the fonts and scripts. Under the motion blur, the 20 % overlay and the grain, a 480 px copy at AVIF
// quality 35 looks the same as the 1200 px copy at 1440 px wide. Source: the 1200 px copies in design/assets/photos.
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = {};
for (const name of ["wildflowers", "bluebells"]) {
	const src = sharp(here(`../../../design/assets/photos/${name}-1200.jpg`));
	const avif = await src.clone().resize(480).avif({ quality: 35, effort: 9 }).toBuffer();
	await src
		.clone()
		.resize(640)
		.jpeg({ quality: 60, mozjpeg: true })
		.toFile(here(`../public/photos/${name}-640.jpg`));
	out[name] = "data:image/avif;base64," + avif.toString("base64");
	console.log(name, avif.length, "bytes AVIF");
}
writeFileSync(
	here("../src/marketing/photo/hero-photos.generated.ts"),
	"// Written by scripts/render-hero-photos.mjs. Do not edit.\nexport const HERO_AVIF = " +
		JSON.stringify(out, null, "\t") +
		" as const;\n",
);
