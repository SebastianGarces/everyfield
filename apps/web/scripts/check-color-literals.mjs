// Fails when a TS or TSX file in apps/web/src or packages/ui/src holds a colour literal (hex, rgb(a), hsl(a), hwb, lab, lch, oklab,
// oklch). Colours live in design/handoff/tokens.css (product tokens) and in the marketing layer of
// src/styles/marketing.css; components reference them by name. Run from apps/web: `node scripts/check-color-literals.mjs`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
// The shared product UI (WP-088) follows the same rule; its colours live in tokens.css and packages/ui/src/foundations/product.css.
const UI = fileURLToPath(new URL("../../../packages/ui/src", import.meta.url));
// A hex colour: not glued to a letter or digit before or after it (so "#features" and "#ef-arrow" anchors do not match),
// not an HTML entity, and also after a Tailwind underscore ("shadow-[0_0_0_#fff]").
const HEX = /(?<![0-9A-Za-z&])#[0-9A-Fa-f]{3,8}(?![0-9A-Za-z])/;
// A colour function, also inside a Tailwind arbitrary value ("_rgba(" or "[rgb("): not preceded by a letter or hyphen.
// Case-insensitive like CSS; the first argument must look like a colour value (a number, "from", "var(" or "none"), so a
// JavaScript call such as Lab({ ... }) is not a match.
const FN = /(?<![A-Za-z-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*(?:[\d.+-]|from(?![A-Za-z])|var\(|none(?![A-Za-z]))/i;
// Files that cannot reference a CSS variable, each with its reason.
const ALLOWED = {
  "app/layout.tsx": "the theme-color meta tag (Next viewport metadata) takes a literal colour",
  "app/apple-icon.tsx": "next/og renders the icon without the page's CSS, so it cannot read a variable",
};

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const found = [];
for (const [root, label] of [[SRC, "src"], [UI, "packages/ui/src"]]) {
  for (const file of walk(root).filter((f) => /\.tsx?$/.test(f))) {
    const rel = file.slice(root.length + 1);
    if (root === SRC && rel in ALLOWED) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const m = line.match(HEX) ?? line.match(FN);
      if (m) found.push(`${label}/${rel}:${i + 1}: ${m[0]}`);
    });
  }
}
if (found.length) {
  console.error(`Colour literals in components (use a token from tokens.css, the marketing layer of marketing.css or product.css):\n${found.join("\n")}`);
  process.exit(1);
}
