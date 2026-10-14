import "server-only";
// Satori (next/og) renders plain <img>; next/image does not apply to generated images. Next exempts metadata image files only.
/* eslint-disable @next/next/no-img-element */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { LOGO_SYMBOLS } from "./logo-symbols";

/**
 * Share images (Open Graph and X large cards). Each page states its approved hero headline and subhead on the
 * hero's field gradient, with the nav logo. No product visuals: those carry demo data, which a card must not show.
 * The routes have no dynamic input, so `next build` renders them once to static PNGs.
 */
export const SHARE_SIZE = { width: 1200, height: 630 };
export const SHARE_TYPE = "image/png";

// Static OFL instances of the site fonts (Satori cannot read variable fonts or woff2). Licences sit next to them.
const FONT_DIR = join(process.cwd(), "src/marketing/share-fonts");
const font = (file: string) => readFile(join(FONT_DIR, file));

// The nav logo from the shared symbols: green mark, ink wordmark.
export function symbolSvg(id: "ef-mark" | "ef-wordmark", color: string) {
  const g = LOGO_SYMBOLS.match(new RegExp(`<symbol id="${id}" viewBox="(?<box>[^"]+)">(?<paths>[\\s\\S]*?)</symbol>`))?.groups;
  if (!g?.box || !g.paths) throw new Error(`logo-symbols.ts: symbol #${id} is missing`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${g.box}">${g.paths.replaceAll("currentColor", color)}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
const MARK = symbolSvg("ef-mark", "#1CE362");
const WORDMARK = symbolSvg("ef-wordmark", "#181D19");

// The hero panel (prototype.css .hero-bg on .gsurf[data-tone="field"]): a field-green layer with film grain that
// fades in from the canvas at the top along an ease-in curve. Satori has no blur, so the green mesh is a few soft
// radial gradients in the field palette instead of the blurred one.
const FIELD = [
  "radial-gradient(circle at 24% 30%, #1CE362 0%, rgba(28,227,98,0) 60%)",
  "radial-gradient(circle at 74% 44%, #4BEC86 0%, rgba(75,236,134,0) 60%)",
  "radial-gradient(circle at 64% 86%, #12C456 0%, rgba(18,196,86,0) 60%)",
  "radial-gradient(circle at 26% 84%, #0FA94A 0%, rgba(15,169,74,0) 55%)",
].join(", ");
// The site masks the green layer (grain included) with an ease-in alpha ramp. Over the canvas that equals painting
// the canvas on top with the inverse ramp, which Satori renders reliably.
const FADE = `linear-gradient(180deg, ${[[1, 8], [0.97, 22], [0.9, 35], [0.78, 48], [0.6, 61], [0.38, 74], [0.15, 87], [0, 100]]
  .map(([a, at]) => `rgba(252,251,248,${a}) ${at}%`)
  .join(", ")})`;

// Grain. The site draws its noise tile (prototype.css .gsurf::after: fractal noise, baseFrequency .95, 3 octaves,
// desaturated, contrast 1.6, 260 px tile) with mix-blend-mode: overlay at .42 opacity. Satori ignores blend modes.
// Overlay is linear in the noise value n on each side of mid grey, so on a base colour b it equals painting
// overlay(b, white) with alpha .42 * (2n - 1) where n > .5, and overlay(b, black) with alpha .42 * (1 - 2n) where n < .5.
// With b = the field green #1CD25E those colours are rgb(56,255,188) and rgb(0,165,0). Same noise, scale and tile.
// resvg's noise comes out stronger than Chrome's, so the strength is .26 rather than .42: at that value the grain's
// measured high-pass amplitude on the green matches a 1:1 capture of the site hero (evidence E7, grain-amplitude.json).
function grainTile(rgb: readonly [number, number, number], alpha: string) {
  const [r, g, b] = rgb.map((c) => (c / 255).toFixed(3));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="260"><filter id="n" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency=".95" numOctaves="3" stitchTiles="stitch"/>` +
    `<feColorMatrix type="saturate" values="0"/>` +
    `<feComponentTransfer><feFuncR type="linear" slope="1.6" intercept="-.3"/><feFuncG type="linear" slope="1.6" intercept="-.3"/><feFuncB type="linear" slope="1.6" intercept="-.3"/></feComponentTransfer>` +
    `<feColorMatrix type="matrix" values="0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} ${alpha}"/>` +
    `</filter><rect width="100%" height="100%" filter="url(#n)"/></svg>`;
  return `url("data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}")`;
}
const GRAIN_LIGHT = grainTile([56, 255, 188], ".52 0 0 0 -.26"); // alpha = .26 * (2n - 1)
const GRAIN_DARK = grainTile([0, 165, 0], "-.52 0 0 0 .26"); // alpha = .26 * (1 - 2n)
const LAYER = { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", display: "flex" } as const;

export async function shareImage({ headline, subhead }: { headline: string; subhead: string }) {
  const [display, body] = await Promise.all([font("bricolage-grotesque-500.woff"), font("instrument-sans-500.woff")]);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 80px 60px",
          backgroundColor: "#FCFBF8",
          color: "#181D19",
          fontFamily: "Instrument Sans",
        }}
      >
        {/* Background only, under the logo and text: field, grain, then the canvas fade over both. */}
        <div style={{ ...LAYER, backgroundColor: "#1CD25E", backgroundImage: FIELD }} />
        <div style={{ ...LAYER, backgroundImage: `${GRAIN_LIGHT}, ${GRAIN_DARK}`, backgroundSize: "260px 260px, 260px 260px", backgroundRepeat: "repeat, repeat" }} />
        <div style={{ ...LAYER, backgroundImage: FADE }} />
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <img src={MARK} width={54} height={44} alt="" />
          <img src={WORDMARK} width={224} height={47} alt="" style={{ marginTop: 4 }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              fontFamily: "Bricolage Grotesque",
              fontSize: 104,
              lineHeight: 1.0,
              letterSpacing: -3.6, // the site's -0.035em at this size; Satori ignores em letter spacing
              color: "#2A332C",
              maxWidth: 1000,
              textWrap: "balance",
            }}
          >
            {headline}
          </div>
          <div style={{ fontSize: 31, lineHeight: 1.35, color: "rgba(24,29,25,.88)", maxWidth: 1000, textWrap: "balance" }}>{subhead}</div>
        </div>
      </div>
    ),
    {
      ...SHARE_SIZE,
      fonts: [
        { name: "Bricolage Grotesque", data: display, weight: 500, style: "normal" },
        { name: "Instrument Sans", data: body, weight: 500, style: "normal" },
      ],
    },
  );
}
