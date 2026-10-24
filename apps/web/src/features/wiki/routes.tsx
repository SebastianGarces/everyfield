import type { Metadata } from "next";
import { WikiActionHost } from "./host.tsx";

export const wikiMetadata: Metadata = { title: "Wiki", robots: { index: false, follow: false } };

/** Action host for the statement census. It is not the wiki screen. */
export function WikiPage() {
	return <WikiActionHost />;
}
