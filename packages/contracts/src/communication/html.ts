/** Safe rich text for a church email body. Scripts and event handlers never remain. */
export function sanitizeHtml(input: string): string {
	let html = input.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
	html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
	html = html.replace(/<\/?(?:iframe|object|embed|link|meta)\b[^>]*>/gi, "");
	html = html.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
	html = html.replace(/javascript:/gi, "");
	return html.trim();
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

/** Thirty 24-hour days. An instant equal to this window is accepted. A later instant is not. */
export const SCHEDULE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function scheduleAccepted(now: Date, at: Date): boolean {
	return at.getTime() <= now.getTime() + SCHEDULE_WINDOW_MS;
}
