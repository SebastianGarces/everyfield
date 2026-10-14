import "server-only";
import type { Metadata } from "next";
import type { LIVE_PAGES } from "@/site";
import { COPY } from "./copy";
import { SHARE_SIZE, SHARE_TYPE } from "./share";

export const SITE_NAME = "EveryField";

/** Alt text for a share image: the words it shows. */
export function shareAlt(headline: string, subhead: string) {
  return `${SITE_NAME}: ${headline} ${subhead}`;
}
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

// shareImage "own": the segment has opengraph-image and twitter-image files. "home": the page falls back to the home image.
type Page = { path: (typeof LIVE_PAGES)[number]; title: string; description: string; shareImage: "own" | "home" };

// Head copy comes from each page's approved copy in design/marketing-copy.json. Over-long text fails the build.
const strip = (s: string) => s.replace(/\.$/, "");
const J = COPY.journey.hero;
const O = COPY.shared.oversight_page.hero;
const A = COPY.shared.access_page.hero;
const L = COPY.shared;
export const PAGES = {
  home: { path: "/", title: strip(J.headline), description: J.subhead, shareImage: "own" },
  oversight: { path: "/oversight", title: strip(O.headline), description: O.subhead, shareImage: "own" },
  access: { path: "/access", title: A.headline, description: A.subhead, shareImage: "home" },
  privacy: { path: "/privacy", title: L.privacy_page.title, description: L.privacy_page.intro?.[0] ?? "", shareImage: "home" },
  terms: { path: "/terms", title: L.terms_page.title, description: L.terms_page.intro?.[0] ?? "", shareImage: "home" },
} satisfies Record<string, Page>;

/** The rendered title, as the layout template formats it. */
export const fullTitle = (p: Page) => `${p.title} · ${SITE_NAME}`;

for (const p of Object.values(PAGES)) {
  if (fullTitle(p).length > TITLE_MAX) throw new Error(`${p.path}: title "${fullTitle(p)}" is over ${TITLE_MAX} characters`);
  if (!p.description || p.description.length > DESCRIPTION_MAX) {
    throw new Error(`${p.path}: description must be 1 to ${DESCRIPTION_MAX} characters (has ${p.description.length})`);
  }
}

// The home share image (app/opengraph-image.tsx, app/twitter-image.tsx). Pages without their own image use it.
const HOME_IMAGE = { width: SHARE_SIZE.width, height: SHARE_SIZE.height, type: SHARE_TYPE, alt: shareAlt(J.headline, J.subhead) };

/**
 * Page head: title, description, canonical URL, Open Graph and X card.
 * Next.js uses a segment's own image files only when the page config sets no images, and a child segment does not
 * inherit them. So "own" pages leave images unset and "home" pages name the home image explicitly.
 */
export function pageMetadata(p: Page): Metadata {
  const title = fullTitle(p);
  const home = p.shareImage === "home";
  return {
    title: { absolute: title },
    description: p.description,
    alternates: { canonical: p.path },
    openGraph: {
      title,
      description: p.description,
      url: p.path,
      siteName: SITE_NAME,
      locale: "en_US",
      type: "website",
      ...(home && { images: [{ url: "/opengraph-image", ...HOME_IMAGE }] }),
    },
    twitter: { card: "summary_large_image", title, description: p.description, ...(home && { images: [{ url: "/twitter-image", ...HOME_IMAGE }] }) },
  };
}

