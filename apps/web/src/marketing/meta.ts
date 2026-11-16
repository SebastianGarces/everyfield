import "server-only";
import type { Metadata } from "next";
import type { LIVE_PAGES } from "@/site";
import { COPY } from "./copy";

export const SITE_NAME = "Everyfield";

function shareAlt(headline: string, subhead: string) {
	return `${SITE_NAME}: ${headline} ${subhead}`;
}
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

type Page = { path: (typeof LIVE_PAGES)[number]; title: string; description: string; shareImage: "own" | "home" };

const strip = (s: string) => s.replace(/\.$/, "");
const J = COPY.journey.hero;
const O = COPY.shared.oversight_page.hero;
const A = COPY.shared.access_page.hero;
const L = COPY.shared;
export const PAGES = {
	home: { path: "/", title: strip(J.headline), description: J.subhead, shareImage: "own" },
	oversight: { path: "/oversight", title: strip(O.headline), description: O.subhead, shareImage: "own" },
	access: { path: "/access", title: A.headline, description: A.subhead, shareImage: "home" },
	privacy: {
		path: "/privacy",
		title: L.privacy_page.title,
		description: L.privacy_page.intro?.[0] ?? "",
		shareImage: "home",
	},
	terms: { path: "/terms", title: L.terms_page.title, description: L.terms_page.intro?.[0] ?? "", shareImage: "home" },
} satisfies Record<string, Page>;

export const fullTitle = (p: Page) => `${p.title} · ${SITE_NAME}`;

for (const p of Object.values(PAGES)) {
	if (fullTitle(p).length > TITLE_MAX)
		throw new Error(`${p.path}: title "${fullTitle(p)}" is over ${TITLE_MAX} characters`);
	if (!p.description || p.description.length > DESCRIPTION_MAX) {
		throw new Error(`${p.path}: description must be 1 to ${DESCRIPTION_MAX} characters (has ${p.description.length})`);
	}
}

const HOME_IMAGE = { width: 1200, height: 630, type: "image/png", alt: shareAlt(J.headline, J.subhead) };

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
			...(home && { images: [{ url: "/opengraph-image.png", ...HOME_IMAGE }] }),
		},
		twitter: {
			card: "summary_large_image",
			title,
			description: p.description,
			...(home && { images: [{ url: "/twitter-image.png", ...HOME_IMAGE }] }),
		},
	};
}
