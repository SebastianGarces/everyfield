// A task description is bounded, safe Markdown (REQ-TSK-016). Create, edit and template import send every description
// through normalizeDescription, so storage holds only the canonical value and every screen renders that one value.
// Pure and client-safe: no database, no HTML parser, no output that a browser could run.

/** The longest description a task keeps, in characters. */
export const MAX_DESCRIPTION = 50_000;

/** Elements whose content is code or hidden markup: the element and everything inside it go. An unclosed one runs to the end. */
const BLOCKS =
	/<(script|style|iframe|object|embed|template|noscript|textarea|title|xmp)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const COMMENTS = /<!--[\s\S]*?(?:-->|$)/g;
/** Any other tag, declaration or processing instruction: the tag goes, the text between tags stays. */
const TAGS = /<[/!?]?[a-z][^>]*>/gi;
// An address may hold one level of parentheses: "javascript:alert(1)".
const LINKS = /\[([^\]\n]*)\]\(((?:[^()\n]|\([^()\n]*\))*)\)/g;

/** Whether a link address may stay a link: http or https with a host, or mailto. Every other scheme loses its link. */
function safeLink(raw: string): boolean {
	const href = raw.trim();
	// Control characters and spaces hide schemes ("java\nscript:").
	if (!href || /[\u0000- \u007f-\u009f]/.test(href)) return false;
	return /^https?:\/\/[^/?#]/i.test(href) || /^mailto:[^\s]+$/i.test(href);
}

/**
 * The canonical description: LF line endings, raw HTML and script removed, a link with any address other than http,
 * https or mailto reduced to its label, trailing spaces and runs of blank lines collapsed, then trimmed. Whitespace
 * only becomes "". Paragraphs, line breaks, emphasis and lists are plain Markdown text and stay as written.
 */
export function normalizeDescription(raw: string): string {
	return raw
		.replace(/\r\n?/g, "\n")
		.replace(COMMENTS, "")
		.replace(BLOCKS, "")
		.replace(TAGS, "")
		.replace(LINKS, (link: string, label: string, href: string) => (safeLink(href) ? link : label))
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
