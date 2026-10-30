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

/** The merge keys delivery fills at send. The Messages field rail lists exactly these. */
export const mergeKeys = ["name", "rsvp_link"] as const;
export type MergeKey = (typeof mergeKeys)[number];

/** True when a stored body holds the `{{rsvp_link}}` field. Such a message can only be sent from an open meeting. */
export const usesRsvpLink = (body: string | null | undefined): boolean => /\{\{\s*rsvp_link\s*\}\}/i.test(body ?? "");

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

export const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * The RSVP button, built by system code from a checked URL. A table cell carries the background, an inline-styled link
 * fills the cell, and a VML shape does the same in Outlook's Word engine. Nothing here depends on a `<style>` block.
 */
function rsvpButton(href: string): string {
	const url = escapeHtml(href);
	return (
		`<table data-rsvp-button="" role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 6px 0;"><tr>` +
		`<td align="center" bgcolor="#1AF197" style="background-color:#1AF197;">` +
		`<!--[if mso]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:46px;v-text-anchor:middle;width:250px;" stroke="f" fillcolor="#1AF197"><w:anchorlock/><center style="color:#181D19;font-family:Arial,sans-serif;font-size:15px;font-weight:600;">Tell us if you can come</center></v:rect><![endif]-->` +
		`<!--[if !mso]><!--><a href="${url}" style="display:block;padding:13px 22px;background-color:#1AF197;color:#181D19;font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;text-align:center;text-decoration:none;">Tell us if you can come</a><!--<![endif]-->` +
		`</td></tr></table>`
	);
}

/** Preview only: a labeled box where the button goes when the app origin cannot make a link. Never sent. */
const rsvpPlaceholder = (): string =>
	`<table data-rsvp-placeholder="" role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 6px 0;"><tr>` +
	`<td align="center" style="border:2px dashed #9A9E98;padding:12px 20px;font-family:${FONT};font-size:14px;color:#666A64;">RSVP button appears here (needs an https app origin)</td></tr></table>`;

export type RenderMode = "send" | "preview";

/**
 * Replace `{{field}}` after sanitizing. An unknown field becomes empty text. `rsvp_link` becomes a link only for a valid
 * RSVP URL and is empty otherwise. Every other value is escaped text, never markup or an attribute.
 */
export function renderBody(input: string, merge: Readonly<Record<string, string>>, mode: RenderMode = "send"): string {
	const field = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;
	// Fields fill text only. A field inside a tag (an href) is dropped, so no merge value reaches an attribute.
	return sanitizeHtml(input)
		.split(/(<[^>]*>)/)
		.map((part) =>
			part.startsWith("<")
				? part.replace(field, "")
				: part.replace(field, (_match, key: string) => {
						if (key.toLowerCase() === "rsvp_link") {
							const href = rsvpHref(merge.rsvp_link);
							if (href) return rsvpButton(href);
							return mode === "preview" ? rsvpPlaceholder() : "";
						}
						return escapeHtml(merge[key] ?? "");
					}),
		)
		.join("")
		.replace(/<p>\s*(<table data-rsvp-(?:button|placeholder)[\s\S]*?<\/table>)\s*<\/p>/g, "$1")
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
