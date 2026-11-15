import { safeLinkAddress } from "../common/links.ts";

export const MAX_DESCRIPTION = 50_000;

const LINKS = /\[([^\]\n]*)\]\(((?:[^()\n]|\([^()\n]*\))*)\)/g;

export function normalizeDescription(raw: string): string {
	return raw
		.replace(/\r\n?/g, "\n")
		.replace(LINKS, (link: string, label: string, href: string) => (safeLinkAddress(href) === null ? label : link))
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
