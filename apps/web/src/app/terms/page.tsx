import type { Metadata } from "next";
import { COPY } from "@/marketing/copy";
import { Legal } from "@/marketing/Legal";
import { PAGES, pageMetadata } from "@/marketing/meta";

const copy = COPY.shared.terms_page;
export const metadata: Metadata = pageMetadata(PAGES.terms);

export default function Terms() {
	return <Legal path="/terms" copy={copy} />;
}
