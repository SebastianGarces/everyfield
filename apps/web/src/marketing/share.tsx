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

// The hero panel: canvas at the top, an ease-in fade into the field green (prototype.css .hero-bg and [data-tone="field"]).
const FIELD =
  "linear-gradient(180deg, #FCFBF8 0%, #FCFBF8 18%, #F1FBF2 34%, #DCF8E4 48%, #B4F2C8 62%, #7DEA9F 76%, #3FDD74 89%, #1CD25E 100%)";

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
          backgroundImage: FIELD,
          color: "#181D19",
          fontFamily: "Instrument Sans",
        }}
      >
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
