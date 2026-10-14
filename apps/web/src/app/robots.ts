import type { MetadataRoute } from "next";
import { LIVE_PAGES, SITE_URL } from "../site";

// Crawlers may fetch the live pages and the assets they need to render; everything else is disallowed.
// "/$" matches the home page only, so "Allow: /" does not reopen the whole site.
export default function robots(): MetadataRoute.Robots {
  const pages = LIVE_PAGES.map((p) => (p === "/" ? "/$" : p));
  return { rules: { userAgent: "*", allow: [...pages, "/_next/static/", "/icon.svg"], disallow: "/" }, sitemap: SITE_URL + "/sitemap.xml" };
}
