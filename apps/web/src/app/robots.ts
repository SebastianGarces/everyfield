import type { MetadataRoute } from "next";
import { LIVE_PAGES, SITE_URL } from "../site";

// Crawlers may fetch the live pages and the assets they need to render; everything else is disallowed.
// "/$" matches the home page only, so "Allow: /" does not reopen the whole site.
// Link-preview bots (X, LinkedIn, Slack) obey robots.txt, so the share images and icons must be allowed too.
const ASSETS = ["/_next/static/", "/icon.svg", "/apple-icon", "/opengraph-image", "/twitter-image", "/oversight/opengraph-image", "/oversight/twitter-image"];

export default function robots(): MetadataRoute.Robots {
  const pages = LIVE_PAGES.map((p) => (p === "/" ? "/$" : p));
  return { rules: { userAgent: "*", allow: [...pages, ...ASSETS], disallow: "/" }, sitemap: SITE_URL + "/sitemap.xml" };
}
