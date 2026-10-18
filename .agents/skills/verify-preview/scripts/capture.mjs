#!/usr/bin/env node
// Before (main) and after (branch) browser evidence in headless Chromium and WebKit.
// Usage: node capture.mjs --before <main preview URL> --after <branch preview URL>
//          --out <evidence dir> [--paths /,/access] [--widths 390,1440] [--engines chromium,webkit] [--flow <flow.mjs>]
// A flow module exports `default async ({ page, side, engine, width, path }) => [{ check, pass, detail }]`.
// Flows run on both sides with video; the after side must pass every check.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const opt = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const urls = { before: opt("before"), after: opt("after") };
const out = resolve(opt("out", ""));
if (!urls.before || !urls.after || !opt("out")) {
  console.error("Usage: node capture.mjs --before <url> --after <url> --out <dir> [--paths /,/x] [--widths 390,1440] [--engines chromium,webkit] [--flow file.mjs]");
  process.exit(2);
}
const paths = opt("paths", "/").split(",");
const widths = opt("widths", "390,1440").split(",").map(Number);
const engines = opt("engines", "chromium,webkit").split(",");
const flow = opt("flow") ? (await import(pathToFileURL(resolve(opt("flow"))).href)).default : null;

// Record which commit each preview serves, so the report binds evidence to exact heads.
const previews = JSON.parse(execFileSync("portless", ["preview", "status", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const meta = Object.fromEntries(Object.entries(urls).map(([side, url]) => {
  const p = previews.find((x) => x.state === "ready" && new URL(x.url).host === new URL(url).host);
  if (!p) throw new Error(`No ready portless preview serves ${url}`);
  return [side, { url, head: p.head, mode: p.mode, previewId: p.id, directory: p.directory }];
}));

// Resolve Playwright, sharp and axe-core from the branch preview's own install; nothing is added to the repo.
const req = createRequire(join(meta.after.directory, "apps/web/package.json"));
const playwright = req("playwright");
const sharp = req("sharp");
const axeSource = (() => {
  let r = req;
  for (const m of ["eslint-config-next", "eslint-plugin-jsx-a11y"]) r = createRequire(r.resolve(m));
  return readFileSync(r.resolve("axe-core/axe.min.js"), "utf8");
})();

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
mkdirSync(join(out, "shots"), { recursive: true });
mkdirSync(join(out, "videos"), { recursive: true });
const slug = (p) => (p === "/" ? "home" : p.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-"));
const shots = [];

async function visit(browser, engine, width, path, side) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  const response = await page.goto(urls[side] + path, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 100)); }
    window.scrollTo(0, 0);
    await document.fonts.ready;
  });
  await page.waitForTimeout(500);
  const file = join(out, "shots", `${engine}-${slug(path)}-${width}-${side}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate((tags) => window.axe.run(document, { runOnly: { type: "tag", values: tags } }), AXE_TAGS);
  await context.close();
  return {
    status: response?.status() ?? 0,
    errors,
    screenshot: relative(out, file),
    axe: axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })),
  };
}

async function runFlow(browser, engine, width, path, side) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, recordVideo: { dir: join(out, "videos"), size: { width, height: 900 } } });
  const page = await context.newPage();
  await page.goto(urls[side] + path, { waitUntil: "networkidle" });
  let checks;
  try {
    checks = await flow({ page, side, engine, width, path });
  } catch (e) {
    checks = [{ check: "flow ran without error", pass: false, detail: e.message.split("\n")[0] }];
  }
  const video = await page.video().path();
  await context.close();
  if (!checks.length) return rmSync(video), {};
  const named = join(out, "videos", `${engine}-${slug(path)}-${width}-${side}.webm`);
  renameSync(video, named);
  return { checks, video: relative(out, named) };
}

async function pixelDiff(a, b) {
  const [x, y] = await Promise.all([a, b].map((f) => sharp(join(out, f)).raw().ensureAlpha().toBuffer({ resolveWithObject: true })));
  if (x.info.width !== y.info.width || x.info.height !== y.info.height) return `size ${x.info.width}x${x.info.height} -> ${y.info.width}x${y.info.height}`;
  let differ = 0;
  for (let i = 0; i < x.data.length; i += 4) if (x.data.readUInt32LE(i) !== y.data.readUInt32LE(i)) differ++;
  return Number(((differ * 100) / (x.info.width * x.info.height)).toFixed(3));
}

for (const engine of engines) {
  const browser = await playwright[engine].launch();
  for (const path of paths) for (const width of widths) {
    const shot = { engine, width, path };
    for (const side of ["before", "after"]) {
      shot[side] = await visit(browser, engine, width, path, side);
      if (flow) Object.assign(shot[side], await runFlow(browser, engine, width, path, side));
    }
    shot.diffPercent = await pixelDiff(shot.before.screenshot, shot.after.screenshot);
    // Fail only on violations main does not have (new rule or more nodes); report the rest.
    const onMain = new Map(shot.before.axe.map((v) => [v.id, v.nodes]));
    shot.newAxe = shot.after.axe.filter((v) => v.nodes > (onMain.get(v.id) ?? 0));
    const failures = [
      shot.after.status !== 200 && `HTTP ${shot.after.status}`,
      ...shot.after.errors,
      ...shot.newAxe.map((v) => `axe ${v.impact} ${v.id} (${v.nodes})`),
      ...(shot.after.checks ?? []).filter((c) => !c.pass).map((c) => `flow: ${c.check}: ${c.detail ?? ""}`),
    ].filter(Boolean);
    shot.verdict = failures.length ? "fail" : "pass";
    shot.failures = failures;
    shots.push(shot);
    console.log(`${shot.verdict.padEnd(4)} ${engine} ${width} ${path} diff=${shot.diffPercent}% ${failures.join("; ")}`);
  }
  await browser.close();
}

const results = { ...meta, engines, widths, paths, verdict: shots.every((s) => s.verdict === "pass") ? "pass" : "fail", shots };
writeFileSync(join(out, "ui-results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(`verdict ${results.verdict}: ${shots.length} shot pairs, before ${meta.before.head.slice(0, 7)}, after ${meta.after.head.slice(0, 7)}`);
process.exitCode = results.verdict === "pass" ? 0 : 1;
