#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const WIDTHS = [390, 1440];
const DIMENSIONS = ["hierarchy", "spacing", "color", "type", "copy"];
const surface = opt("surface");
const evidence = opt("out");
const prototype = opt("prototype", "design/everyfield-ui.html");
const section = opt("section");
const approved = opt("approved");
const built = Object.fromEntries(WIDTHS.map((w) => [w, opt(`built-${w}`)]));
const given = Object.fromEntries(WIDTHS.map((w) => [w, opt(`reference-${w}`)]));
if (!surface || !evidence || WIDTHS.some((w) => !built[w]) || (!section && !approved) || (approved && WIDTHS.some((w) => !given[w]))) {
  console.error(
    [
      "Usage: node design-match.mjs --surface <id> --out <evidence dir> --built-390 <png> --built-1440 <png>",
      "         (--section <data-page or marketing page> [--prototype design/everyfield-ui.html|design/everyfield-marketing.html]",
      "          | --approved <link or path> --reference-390 <png> --reference-1440 <png>)",
      "everyfield-ui.html is a desktop prototype: its 1440 px capture is the 390 px reference unless --reference-390 names a phone design.",
    ].join("\n"),
  );
  process.exit(2);
}

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const req = createRequire(join(root, "apps/web/package.json"));
const sharp = req("sharp");
const dir = join(resolve(evidence), "design-match", surface);
mkdirSync(dir, { recursive: true });

async function captureSection() {
  const { chromium } = req("playwright");
  const marketing = prototype.endsWith("everyfield-marketing.html");
  const url = pathToFileURL(join(root, prototype)).href;
  const browser = await chromium.launch();
  try {
    for (const width of WIDTHS) {
      if (given[width]) continue;
      if (!marketing && width < 1440) continue;
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
      const page = await context.newPage();
      await page.goto(`${url}#/${marketing && section === "home" ? "" : section}`, { waitUntil: "load" });
      if (!marketing) {
        const active = await page.evaluate((name) => {
          const detail = Object.entries(DETAIL).find(([, [p]]) => p === name);
          if (detail) location.hash = `#/${detail[0]}`;
          return document.querySelector(`.page[data-page="${name}"]`) !== null;
        }, section);
        if (!active) throw new Error(`${prototype} has no section "${section}"`);
        await page.waitForFunction((name) => document.querySelector('.page[data-active="true"]')?.dataset.page === name, section);
      }
      await page.addStyleTag({ content: ".doc-dock { display: none !important; }" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(800);
      given[width] = join(dir, `reference-${width}.png`);
      await page.screenshot({ path: given[width], animations: "disabled" });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  for (const width of WIDTHS) given[width] ??= given[1440];
}

const GAP = 24;
const LABEL = 40;
const escape = (text) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

async function compose(width, left, right, title) {
  const sides = await Promise.all([left, right].map(async (file) => ({ file, ...(await sharp(file).metadata()) })));
  const height = Math.max(...sides.map((s) => s.height)) + LABEL;
  const total = sides.reduce((sum, s) => sum + s.width, 0) + GAP;
  const label = (text, x) =>
    `<text x="${x}" y="26" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#1f2421">${escape(text)}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${LABEL}">${label(`Built: ${surface} at ${width} px`, 8)}${label(title, sides[0].width + GAP + 8)}</svg>`;
  const out = join(dir, `${width}.png`);
  await sharp({ create: { width: total, height, channels: 3, background: "#d9dcd8" } })
    .composite([
      { input: Buffer.from(svg), left: 0, top: 0 },
      { input: sides[0].file, left: 0, top: LABEL },
      { input: sides[1].file, left: sides[0].width + GAP, top: LABEL },
    ])
    .png()
    .toFile(out);
  return out;
}

if (!approved) await captureSection();
const reference = approved ? { approved } : { prototype, section };
const title = (width) => {
  const shown = width !== 1440 && given[width] === given[1440] ? "1440 px, the prototype has no phone layout" : `${width} px`;
  return approved ? `Reference: ${approved}` : `Reference: ${prototype} section "${section}" at ${shown}`;
};
for (const width of WIDTHS) console.log(await compose(width, resolve(built[width]), resolve(given[width]), title(width)));

const scores = join(dir, "scores.json");
if (!existsSync(scores)) {
  const blank = Object.fromEntries(DIMENSIONS.map((d) => [d, { score: null, reason: "" }]));
  writeFileSync(scores, `${JSON.stringify({ reference, widths: { 390: blank, 1440: blank } }, null, 2)}\n`);
  console.log(`${scores}: fill in each score and reason`);
}
