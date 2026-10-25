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

/** Replace `{{field}}` after sanitizing. An unknown field becomes empty text. */
export function renderBody(input: string, merge: Readonly<Record<string, string>>): string {
	return sanitizeHtml(input).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, key: string) =>
		escapeHtml(merge[key] ?? ""),
	);
}

export function plainText(input: string): string {
	return sanitizeHtml(input)
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
