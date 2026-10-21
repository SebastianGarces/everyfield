// Writes the small hero copies of the blurred hero photos into public/photos: <name>-640.avif and <name>-640.jpg.
// Run from apps/web: `node scripts/render-hero-photos.mjs`.
//
// Why: the hero photo is the page's LCP element. Under the motion blur, the 20 % overlay and the grain, a 640 px copy at
// AVIF quality 35 looks the same as the 1200 px copy at 1440 px wide, at a fifth of the bytes (about 9 KB, not 41 KB).
// Source: the 1200 px web copies in design/assets/photos (the originals stay in Sebastian's files).
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
for (const name of ["wildflowers", "bluebells"]) {
	const src = sharp(here(`../../../design/assets/photos/${name}-1200.jpg`)).resize(640);
	await src
		.clone()
		.avif({ quality: 35, effort: 9 })
		.toFile(here(`../public/photos/${name}-640.avif`));
	await src
		.clone()
		.jpeg({ quality: 60, mozjpeg: true })
		.toFile(here(`../public/photos/${name}-640.jpg`));
	console.log(name, "640");
}
