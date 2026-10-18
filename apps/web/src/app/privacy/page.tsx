import type { Metadata } from "next";
import { COPY } from "@/marketing/copy";
import { Legal } from "@/marketing/Legal";
import { PAGES, pageMetadata } from "@/marketing/meta";

const copy = COPY.shared.privacy_page;
export const metadata: Metadata = pageMetadata(PAGES.privacy);

export default function Privacy() {
	return <Legal path="/privacy" copy={copy} />;
}
