import type { MetadataRoute } from "next";
import { LIVE_PAGES, SITE_URL } from "../site";

export default function sitemap(): MetadataRoute.Sitemap {
  return LIVE_PAGES.map((p) => ({ url: SITE_URL + p, changeFrequency: "monthly", priority: p === "/" ? 1 : 0.6 }));
}
