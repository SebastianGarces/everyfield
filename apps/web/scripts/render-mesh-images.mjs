// Renders the gradient surfaces' blurred mesh, one SVG per tone, into public/mesh. Run from apps/web:
// `node scripts/render-mesh-images.mjs`. `--check` exits 1 when an image is out of date (tones, styles or this script
// changed since the last render, or an SVG was edited by hand).
//
// Why: the gradient surfaces (mk-gsurf: hero panels, InsightCards, the CTA box, rail art) drew five radial gradients under
// `filter: blur(52px) saturate(1.1)` on a pseudo-element. Firefox repaints that filter while the page scrolls (up to
// 27 ms per frame at 390 px). As a background image the same picture is rasterized once per size and cached.
//
// Why SVG and not a bitmap: the blur is 52 CSS px at every size, while the gradients scale with the surface. A bitmap
// baked at one size is visibly off at others (CIEDE2000 p99 8.6 on a 302 px card baked at 672 px). The SVG has no
// viewBox, so its user units are CSS pixels at the size it is drawn: same geometry and same blur as the CSS at any size.
//
// Why a browser: Chromium draws `in oklch` from a colour to transparent as one constant colour with a falling alpha.
// For near-grey colours (very low chroma) the hue counts as missing and becomes 0 degrees, a faint pink. That is part
// of the approved look, so the fade colour of each gradient is sampled from Chromium rather than computed.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const read = (p) => readFileSync(here(p));
const OUT = "../public/mesh";
const LOCK = "./mesh-images.lock.json";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const KEYS = ["base", "g1", "g2", "g3", "g4", "g5"];

// Tones from the g-* utilities in marketing.css (token references resolved through tokens.css).
const tokens = Object.fromEntries([...read("../../../design/handoff/tokens.css").toString().matchAll(/(--ef-grad-[\w-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
const tones = {};
for (const m of read("../src/styles/marketing.css").toString().matchAll(/@utility g-(\w+) \{([^}]*)\}/g)) {
  const v = Object.fromEntries([...m[2].matchAll(/--g-?(base|g?\d)\s*:\s*([^;]+);/g)].map((x) => [x[1].startsWith("g") || x[1] === "base" ? x[1] : "g" + x[1], x[2].trim()]));
  const val = (k) => { const s = v[k] ?? ""; const r = s.match(/var\((--ef-grad-[\w-]+)\)/); return (r ? tokens[r[1]] : s).toUpperCase(); };
  tones[m[1]] = Object.fromEntries(KEYS.map((k) => [k, val(k)]));
}
const outputs = Object.keys(tones).map((t) => `${OUT}/${t}.svg`);
// The images depend on the tone colours and on this script only (not on unrelated style edits).
const inputHash = () => sha(Buffer.concat([read("./render-mesh-images.mjs"), Buffer.from(JSON.stringify(tones))]));

if (process.argv.includes("--check")) {
  const lock = JSON.parse(read(LOCK).toString());
  const stale = [];
  if (lock.inputs !== inputHash()) stale.push("tones, styles or the script changed");
  for (const f of outputs) { let h = ""; try { h = sha(read(f)); } catch { /* missing */ } if (lock.outputs[f] !== h) stale.push(`${f} differs from the last render`); }
  if (stale.length) { console.error(`Mesh images are out of date (${stale.join("; ")}). Run: node scripts/render-mesh-images.mjs`); process.exit(1); }
  process.exit(0);
}

const { chromium } = await import("playwright");
const sharp = (await import("sharp")).default;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 4 }, deviceScaleFactor: 1 });
// The fade colour: the gradient over black, 1 % in (alpha 0.99), divided by its alpha.
async function fade(hex) {
  await page.setContent(`<body style="margin:0;background:#000"><div style="width:1000px;height:4px;background:linear-gradient(in oklch to right, ${hex}, transparent)"></div>`);
  const px = await sharp(await page.screenshot({ clip: { x: 10, y: 1, width: 1, height: 1 } })).raw().toBuffer();
  const a = 1 - 10.5 / 1000;
  return "#" + [0, 1, 2].map((j) => Math.min(255, Math.round(px[j] / a)).toString(16).padStart(2, "0")).join("").toUpperCase();
}
const stops = (c, end) => `<stop offset="0" stop-color="${c}"/><stop offset="${end}" stop-color="${c}" stop-opacity="0"/>`;
// The CSS: on a box at inset -25 % (150 % of the surface), radial-gradient(in oklch circle at 82% 18%, g5 0%,
// transparent 22%) and four ellipses "rx ry at cx cy, gN 0%, transparent 72%"; blur(52px) saturate(1.1); over the base.
// Ellipses: objectBoundingBox on that box, translate(cx cy) scale(rx ry), r = 1. The circle's size is farthest-corner,
// a true circle whatever the aspect, so it is drawn in user space as % of the surface: centre (-25 + 0.82 * 150) %
// = 98 %, (-25 + 0.18 * 150) % = 2 %; radius 0.82 * 150 % of the diagonal = 173.95 % of the normalised diagonal.
const ell = (id, c, rx, ry, cx, cy, end) => `<radialGradient id="${id}" cx="0" cy="0" r="1" gradientTransform="translate(${cx} ${cy}) scale(${rx} ${ry})">${stops(c, end)}</radialGradient>`;
mkdirSync(here(OUT), { recursive: true });
const lock = { inputs: inputHash(), outputs: {} };
for (const [tone, c] of Object.entries(tones)) {
  const f = {};
  for (const k of ["g1", "g2", "g3", "g4", "g5"]) f[k] = await fade(c[k]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" preserveAspectRatio="none"><defs>` +
    `<radialGradient id="a" gradientUnits="userSpaceOnUse" cx="98%" cy="2%" r="173.95%">${stops(f.g5, 0.22)}</radialGradient>` +
    ell("b", f.g1, 0.38, 0.44, 0.24, 0.26, 0.72) + ell("c", f.g2, 0.44, 0.48, 0.74, 0.38, 0.72) + ell("d", f.g3, 0.46, 0.42, 0.64, 0.8, 0.72) + ell("e", f.g4, 0.36, 0.38, 0.26, 0.78, 0.72) +
    `<filter id="f" filterUnits="userSpaceOnUse" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="52"/><feColorMatrix type="saturate" values="1.1"/></filter></defs>` +
    `<rect width="100%" height="100%" fill="${c.base}"/>` +
    `<g filter="url(#f)">${["e", "d", "c", "b", "a"].map((id) => `<rect x="-25%" y="-25%" width="150%" height="150%" fill="url(#${id})"/>`).join("")}</g></svg>\n`;
  const file = `${OUT}/${tone}.svg`;
  writeFileSync(here(file), svg);
  lock.outputs[file] = sha(Buffer.from(svg));
  console.log(file, svg.length, "bytes");
}
await browser.close();
writeFileSync(here(LOCK), JSON.stringify(lock, null, 2) + "\n");
