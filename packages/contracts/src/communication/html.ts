import sanitize from "sanitize-html";

/** Tags a church email may keep. Everything else is discarded, including its nested content when it is a script. */
const allowedTags = [
	"a",
	"b",
	"blockquote",
	"br",
	"em",
	"h1",
	"h2",
	"h3",
	"i",
	"li",
	"ol",
	"p",
	"span",
	"strong",
	"u",
	"ul",
];

/**
 * Allowlist sanitizer. It parses the markup, so a nested or unclosed tag cannot reassemble into a script.
 * The repo had no HTML parser. sanitize-html parses with htmlparser2 and keeps only this email subset.
 */
export function sanitizeHtml(input: string): string {
	return sanitize(input, {
		allowedTags,
		allowedAttributes: { a: ["href"] },
		allowedSchemes: ["http", "https", "mailto"],
		allowProtocolRelative: false,
		disallowedTagsMode: "discard",
	}).trim();
}

export function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** True when a stored body holds the `{{rsvp_link}}` field. Such a message can only be sent from an open meeting. */
export const usesRsvpLink = (body: string | null | undefined): boolean => /\{\{\s*rsvp_link\s*\}\}/i.test(body ?? "");

const RSVP_LINK_TEXT = "Tell us if you can come";

/** The one merge value that becomes markup: an absolute https URL whose path is `/rsvp/<token>`. Anything else is null. */
function rsvpHref(value: string | undefined): string | null {
	if (!value) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
	if (!/^\/rsvp\/[A-Za-z0-9_-]+$/.test(url.pathname)) return null;
	return value === url.origin + url.pathname ? value : null;
}

/**
 * Replace `{{field}}` after sanitizing. An unknown field becomes empty text. `rsvp_link` becomes a link only for a valid
 * RSVP URL and is empty otherwise. Every other value is escaped text, never markup or an attribute.
 */
export function renderBody(input: string, merge: Readonly<Record<string, string>>): string {
	return sanitizeHtml(input)
		.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, key: string) => {
			if (key.toLowerCase() === "rsvp_link") {
				const href = rsvpHref(merge.rsvp_link);
				return href ? `<a href="${escapeHtml(href)}"><strong>${RSVP_LINK_TEXT}</strong></a>` : "";
			}
			return escapeHtml(merge[key] ?? "");
		})
		.replace(/<p>\s*<\/p>/g, "");
}

/** Text part of a body. A link is written as its text followed by its URL. */
export function plainText(input: string): string {
	return sanitizeHtml(input)
		.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_m, href: string, inner: string) => {
			const url = href.replaceAll("&amp;", "&");
			const label = inner.replace(/<[^>]+>/g, "").trim();
			return label && label !== url ? ` ${label} ${url} ` : ` ${url} `;
		})
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Thirty 24-hour days. An instant equal to this window is accepted. A later instant is not. A past instant is not. */
export const SCHEDULE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function scheduleAccepted(now: Date, at: Date): boolean {
	return at.getTime() >= now.getTime() && at.getTime() <= now.getTime() + SCHEDULE_WINDOW_MS;
}

/** A protected security message. The caller stores the token only inside the sealed mail payload. */
export function renderTransactional(
	purpose: "password_reset",
	token: string,
): { subject: string; html: string; text: string } {
	if (purpose !== "password_reset" || token.length < 1) throw new Error("invalid_transactional_message");
	const safe = escapeHtml(token);
	return {
		subject: "Reset your password",
		html: `<p>Reset your password: ${safe}</p>`,
		text: `Reset your password: ${token}`,
	};
}
