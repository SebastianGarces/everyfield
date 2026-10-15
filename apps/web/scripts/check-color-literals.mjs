// Fails when a TS or TSX file in apps/web/src holds a colour literal (hex, rgb(a), hsl(a), hwb, lab, lch, oklab,
// oklch). Colours live in design/handoff/tokens.css (product tokens) and in the marketing layer of
// src/styles/marketing.css; components reference them by name. Run from apps/web: `node scripts/check-color-literals.mjs`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
// A hex colour: not part of a longer word (so "#features" and "#ef-arrow" anchors do not match), and not an HTML entity.
const HEX = /(?<![\w&])#[0-9A-Fa-f]{3,8}(?![0-9A-Za-z])/;
// A colour function, also inside a Tailwind arbitrary value ("_rgba(" or "[rgb("): not preceded by a letter or hyphen.
const FN = /(?<![A-Za-z-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;
// Files that cannot reference a CSS variable, each with its reason.
const ALLOWED = {
  "app/layout.tsx": "the theme-color meta tag (Next viewport metadata) takes a literal colour",
  "app/apple-icon.tsx": "next/og renders the icon without the page's CSS, so it cannot read a variable",
};

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const found = [];
for (const file of walk(SRC).filter((f) => /\.tsx?$/.test(f))) {
  const rel = file.slice(SRC.length + 1);
  if (rel in ALLOWED) continue;
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    const m = line.match(HEX) ?? line.match(FN);
    if (m) found.push(`src/${rel}:${i + 1}: ${m[0]}`);
  });
}
if (found.length) {
  console.error(`Colour literals in components (use a token from tokens.css or the marketing layer of marketing.css):\n${found.join("\n")}`);
  process.exit(1);
}
