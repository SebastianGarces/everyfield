// Writes the small hero copies of the two hero photos into public/photos: <name>-hero.avif (480 px, AVIF quality 35,
// about 7 KB) and <name>-640.jpg (the fallback for browsers without AVIF). Run from apps/web:
// `node scripts/render-hero-photos.mjs`. Source: the 1200 px copies in design/assets/photos.
//
// Why: the hero photo is the page's LCP element. Under the motion blur, the 20 % overlay and the grain, the 480 px copy
// looks the same as the 1200 px copy at 1440 px wide, at a sixth of the bytes.
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
for (const name of ["wildflowers", "bluebells"]) {
	const src = sharp(here(`../../../design/assets/photos/${name}-1200.jpg`));
	await src
		.clone()
		.resize(480)
		.avif({ quality: 35, effort: 9 })
		.toFile(here(`../public/photos/${name}-hero.avif`));
	await src
		.clone()
		.resize(640)
		.jpeg({ quality: 60, mozjpeg: true })
		.toFile(here(`../public/photos/${name}-640.jpg`));
	console.log(name);
}
