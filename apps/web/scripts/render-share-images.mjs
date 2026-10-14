// Renders the share images (Open Graph and X cards) for / and /oversight into src/app as static metadata files.
// Run from apps/web: `node scripts/render-share-images.mjs`. `--check` exits 1 when an image is out of date
// (copy, styles, logo, fonts or this script changed since the last render, or a PNG was edited by hand).
//
// Why a browser: each image is the site's own card surface (.gsurf[data-tone] in prototype.css: blurred OKLCH mesh,
// film grain with mix-blend-mode: overlay). next/og cannot blur, interpolate in OKLCH or blend, so Chromium renders
// the real CSS once and the PNGs are committed. Vercel builds have no browser, so this runs locally, not in `next build`.
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
const copy = JSON.parse(read("../../../design/marketing-copy.json").toString().replace(/Everyfield/g, "EveryField"));
const IMAGES = [
  { dir: "../src/app", tone: "field", hero: copy.directions[0].sections.hero },
  { dir: "../src/app/oversight", tone: "sky", hero: copy.shared.oversight_page.hero },
];
const alt = (h) => `EveryField: ${h.headline} ${h.subhead}`; // shareAlt in src/marketing/meta.ts

const INPUTS = ["./render-share-images.mjs", "../src/styles/prototype.css", "../src/marketing/logo-symbols.ts",
  "../src/marketing/share-fonts/bricolage-grotesque-500.woff", "../src/marketing/share-fonts/instrument-sans-500.woff"];
const sha = (b) => createHash("sha256").update(b).digest("hex");
const inputHash = () => sha(Buffer.concat([...INPUTS.map(read), Buffer.from(JSON.stringify(IMAGES))]));
const LOCK = "./share-images.lock.json";
const outputs = (img) => ["opengraph-image.png", "twitter-image.png"].map((f) => `${img.dir}/${f}`);

if (process.argv.includes("--check")) {
  const lock = JSON.parse(read(LOCK).toString());
  const stale = [];
  if (lock.inputs !== inputHash()) stale.push("copy, styles, logo, fonts or the script changed");
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
const fontUrl = (f) => "data:font/woff;base64," + read(`../src/marketing/share-fonts/${f}`).toString("base64");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const page = (img) => `<!doctype html><html><head><meta charset="utf-8">
<style>${read("../src/styles/prototype.css")}</style>
<style>
@font-face { font-family: "Share Bricolage"; src: url(${fontUrl("bricolage-grotesque-500.woff")}) format("woff"); font-weight: 500; }
@font-face { font-family: "Share Instrument"; src: url(${fontUrl("instrument-sans-500.woff")}) format("woff"); font-weight: 500; }
:root { --font-bricolage: "Share Bricolage"; --font-instrument: "Share Instrument"; }
html, body { margin: 0; background: #FCFBF8; }
#card { width: ${SIZE.width}px; height: ${SIZE.height}px; box-sizing: border-box; padding: 64px 80px 60px; display: flex; flex-direction: column; justify-content: space-between; }
#card .logo { gap: 20px; }
#card .logo .lm { width: 54px; height: 44px; color: #181D19; }
#card .logo .lw { width: 224px; height: 47px; color: #181D19; }
#card h1 { margin: 0; font-size: 104px; max-width: 1000px; color: var(--on); }
#card p { margin: 28px 0 0; font-family: var(--mk-font-body); font-weight: 500; font-size: 31px; line-height: 1.35; max-width: 1000px; color: var(--on); text-wrap: balance; }
</style></head>
<body class="mk-signal"><svg width="0" height="0" style="position:absolute" aria-hidden="true">${symbols}</svg>
<div id="card" class="gsurf" data-tone="${img.tone}">
  <span class="logo"><svg class="lm" viewBox="0 0 657 530"><use href="#ef-mark"/></svg><svg class="lw" viewBox="0 0 890 186"><use href="#ef-wordmark"/></svg></span>
  <div><h1 class="display">${esc(img.hero.headline)}</h1><p>${esc(img.hero.subhead)}</p></div>
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
