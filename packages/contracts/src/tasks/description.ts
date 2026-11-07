// A task description is bounded Markdown kept as the person typed it (REQ-TSK-016, decisions.md D88). Create, edit and template
// import send every description through normalizeDescription, so storage holds only the canonical value and every
// screen renders that one value. Raw HTML, script and HTML comments stay as literal text: safety comes from rendering,
// where every screen draws the value as text nodes through the shared safe Markdown renderer and never as HTML.
// Pure and client-safe: no database, no HTML parser.

import { safeLinkAddress } from "../common/links.ts";

/** The longest description a task keeps, in characters. */
export const MAX_DESCRIPTION = 50_000;

// An address may hold one level of parentheses: "javascript:alert(1)".
const LINKS = /\[([^\]\n]*)\]\(((?:[^()\n]|\([^()\n]*\))*)\)/g;

/**
 * The canonical description: LF line endings, a Markdown link with any address other than http, https or mailto
 * reduced to its label, trailing spaces and runs of blank lines collapsed, then trimmed. Whitespace only becomes "".
 * Everything else, HTML tags, script and comments included, stays exactly as written and is shown as plain text.
 */
export function normalizeDescription(raw: string): string {
	return raw
		.replace(/\r\n?/g, "\n")
		.replace(LINKS, (link: string, label: string, href: string) => (safeLinkAddress(href) === null ? label : link))
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
