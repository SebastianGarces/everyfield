// Renders the share images (Open Graph and X cards) for / and /oversight into src/app as static metadata files.
// Run from apps/web: `node scripts/render-share-images.mjs`. `--check` exits 1 when an image is out of date
// (copy, styles, logo, fonts, photos or this script changed since the last render, or a PNG was edited by hand).
//
// Why a browser: each image is the page's hero in the fade style (foundations.md, Brand): the treated hero photo (20 %
// black overlay, film grain with mix-blend-mode: overlay) fading up from the canvas under the ink lockup and the hero
// copy. next/og cannot mask or blend, so Chromium renders the CSS once and the PNGs are committed. Vercel builds have no
// browser, so this runs locally, not in `next build`.
// Why sharp: grain does not compress; a palette PNG keeps each image under 300 KB, the limit WhatsApp and similar
// apps are reported to apply to link previews. Next.js already depends on sharp; it is declared here as a dev tool.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const read = (p) => readFileSync(here(p));
const MAX_BYTES = 300 * 1024;
const SIZE = { width: 1200, height: 630 };

// Copy: the approved hero copy in design/marketing-copy.json (the same fields src/marketing/meta.ts uses).
const copy = JSON.parse(read("../../../design/marketing-copy.json").toString());
const IMAGES = [
  { dir: "../src/app", photo: "wildflowers", hero: copy.directions[0].sections.hero },
  { dir: "../src/app/oversight", photo: "bluebells", hero: copy.shared.oversight_page.hero },
];
const alt = (h) => `Everyfield: ${h.headline} ${h.subhead}`; // shareAlt in src/marketing/meta.ts

const FONTS = ["../src/marketing/share-fonts/dm-serif-display-400.woff2", "../src/marketing/share-fonts/dm-sans-500.woff2"];
const photoFile = (img) => `../src/marketing/photo/files/${img.photo}.jpg`;
const INPUTS = ["./render-share-images.mjs", "../src/marketing/logo-symbols.ts", ...FONTS, ...IMAGES.map(photoFile)];
const sha = (b) => createHash("sha256").update(b).digest("hex");
const inputHash = () => sha(Buffer.concat([...INPUTS.map(read), Buffer.from(JSON.stringify(IMAGES))]));
const LOCK = "./share-images.lock.json";
const outputs = (img) => ["opengraph-image.png", "twitter-image.png"].map((f) => `${img.dir}/${f}`);

if (process.argv.includes("--check")) {
  const lock = JSON.parse(read(LOCK).toString());
  const stale = [];
  if (lock.inputs !== inputHash()) stale.push("copy, styles, logo, fonts, photos or the script changed");
  for (const img of IMAGES) {
    for (const f of outputs(img)) if (lock.outputs[f] !== sha(read(f))) stale.push(`${f} differs from the last render`);
    for (const f of outputs(img).map((p) => p.replace(".png", ".alt.txt"))) if (read(f).toString() !== alt(img.hero)) stale.push(`${f} is out of date`);
  }
  if (stale.length) {
    console.error(`Share images are out of date (${stale.join("; ")}). Run: node scripts/render-share-images.mjs`);
    process.exit(1);
  }
  process.exit(0);
}

const { chromium } = await import("playwright");
const sharp = (await import("sharp")).default;

const literal = read("../src/marketing/logo-symbols.ts").toString().match(/LOGO_SYMBOLS =\s*(".*");/s)?.[1];
if (!literal) throw new Error("logo-symbols.ts: LOGO_SYMBOLS not found");
const symbols = JSON.parse(literal);
const dataUrl = (p, type) => `data:${type};base64,` + read(p).toString("base64");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const GRAIN = read("../src/styles/marketing.css").toString().match(/--mk-grain: (url\("data:image\/svg\+xml[^"]+"\));/)?.[1];
if (!GRAIN) throw new Error("marketing.css: --mk-grain not found");

// The hero in the fade style (HeroPanel, the mk-photo and hero-fade utilities in marketing.css), at share-card size: the
// photo is clear to 40 % of the height and full from 100 %, so the ink copy sits on the canvas.
const page = (img) => `<!doctype html><html><head><meta charset="utf-8">
<style>
@font-face { font-family: "Share Serif"; src: url(${dataUrl(FONTS[0], "font/woff2")}) format("woff2"); font-weight: 400; }
@font-face { font-family: "Share Sans"; src: url(${dataUrl(FONTS[1], "font/woff2")}) format("woff2"); font-weight: 500; }
html, body { margin: 0; background: #FCFBF8; color: #181D19; -webkit-font-smoothing: antialiased; }
svg { display: block; }
#card { position: relative; isolation: isolate; width: ${SIZE.width}px; height: ${SIZE.height}px; box-sizing: border-box; padding: 64px 80px; display: flex; flex-direction: column; gap: 56px; overflow: hidden; }
.bg { position: absolute; inset: 0; z-index: -1; --a: 40%; --d: 60%;
  mask-image: linear-gradient(to bottom, rgba(0,0,0,0) var(--a), rgba(0,0,0,.03) calc(var(--a) + var(--d) * .15), rgba(0,0,0,.1) calc(var(--a) + var(--d) * .3), rgba(0,0,0,.22) calc(var(--a) + var(--d) * .45), rgba(0,0,0,.4) calc(var(--a) + var(--d) * .6), rgba(0,0,0,.62) calc(var(--a) + var(--d) * .75), rgba(0,0,0,.85) calc(var(--a) + var(--d) * .9), #000 calc(var(--a) + var(--d))); }
.bg img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; filter: brightness(.8); }
.bg::after { content: ""; position: absolute; inset: 0; background: ${GRAIN} 0 0 / 260px 260px; opacity: .34; mix-blend-mode: overlay; }
.lockup { align-self: flex-start; width: auto; height: 44px; aspect-ratio: 1308 / 241; color: #181D19; }
h1 { margin: 0; font-family: "Share Serif", serif; font-weight: 400; font-size: 76px; line-height: 1.04; letter-spacing: -0.02em; max-width: 1000px; text-wrap: balance; }
p { margin: 24px 0 0; font-family: "Share Sans", sans-serif; font-weight: 500; font-size: 28px; line-height: 1.35; max-width: 960px; text-wrap: balance; }
</style></head>
<body><svg width="0" height="0" style="position:absolute" aria-hidden="true">${symbols}
<symbol id="ef-lockup" viewBox="0 0 1308 241"><use href="#ef-symbol" x="0" y="23.668" width="192.33" height="192.33"/><use href="#ef-wordmark" x="256.489" y="0" width="1052" height="241"/></symbol></svg>
<div id="card">
  <span class="bg"><img src="${dataUrl(photoFile(img), "image/jpeg")}" alt=""></span>
  <svg class="lockup" viewBox="0 0 1308 241"><use href="#ef-lockup"/></svg>
  <div><h1>${esc(img.hero.headline)}</h1><p>${esc(img.hero.subhead)}</p></div>
</div></body></html>`;

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
const lock = { note: "Written by scripts/render-share-images.mjs. Do not edit.", inputs: inputHash(), outputs: {} };
for (const img of IMAGES) {
  await tab.setContent(page(img), { waitUntil: "load" });
  await tab.evaluate(() => document.fonts.ready);
  const raw = await tab.locator("#card").screenshot();
  let png;
  for (const quality of [100, 95, 90, 85, 80]) {
    png = await sharp(raw).png({ palette: true, colours: 256, quality, dither: 1, effort: 10, compressionLevel: 9 }).toBuffer();
    if (png.length <= MAX_BYTES) break;
  }
  if (png.length > MAX_BYTES) throw new Error(`${img.dir}: ${png.length} bytes is over ${MAX_BYTES}`);
  for (const f of outputs(img)) {
    writeFileSync(here(f), png);
    writeFileSync(here(f.replace(".png", ".alt.txt")), alt(img.hero));
    lock.outputs[f] = sha(png);
  }
  console.log(`${img.dir}: ${png.length} bytes`);
}
await browser.close();
writeFileSync(here(LOCK), JSON.stringify(lock, null, 2) + "\n");
