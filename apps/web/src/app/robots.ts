import type { MetadataRoute } from "next";
import { LIVE_PAGES, SITE_URL } from "../site";

const ASSETS = [
	"/_next/static/",
	"/icon.svg",
	"/apple-icon",
	"/opengraph-image",
	"/twitter-image",
	"/oversight/opengraph-image",
	"/oversight/twitter-image",
];

export default function robots(): MetadataRoute.Robots {
	const pages = LIVE_PAGES.map((p) => (p === "/" ? "/$" : p));
	return { rules: { userAgent: "*", allow: [...pages, ...ASSETS], disallow: "/" }, sitemap: SITE_URL + "/sitemap.xml" };
}
