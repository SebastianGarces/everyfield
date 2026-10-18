// Pure boundary helpers. Neither a local URL nor a crawler creates authority.
export function safeReturn(input: string | null | undefined): string | null {
	if (!input || input.length > 8192 || !input.startsWith("/") || input.startsWith("//")) return null;
	let decoded = input;
	try {
		for (;;) {
			if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith("//")) return null;
			const next = decoded.replace(/%([a-f0-9]{2})/gi, (_, hex: string) =>
				String.fromCharCode(Number.parseInt(hex, 16)),
			);
			if (next === decoded) break;
			decoded = next;
		}
		const url = new URL(input, "https://local.invalid");
		if (url.origin !== "https://local.invalid" || url.pathname.startsWith("//")) return null;
		return input;
	} catch {
		return null;
	}
}

export function invalidSessionReturn(returnTo: string | null | undefined): string {
	const path = safeReturn(returnTo);
	// Authentication screens stay directly reachable with an expired cookie.
	if (!path || /^\/(?:signin|login|recover-password)(?:[/?#]|$)/.test(path)) return "/signin";
	return `/signin?returnTo=${encodeURIComponent(path)}`;
}

export type PublicPreview = { kind: "public_wiki_metadata" } | { kind: "ordinary" };
export function classifyPublicPreview(actualUrl: string, userAgent: string, method: string): PublicPreview {
	if (method !== "GET") return { kind: "ordinary" };
	let path: string;
	try {
		path = new URL(actualUrl).pathname;
	} catch {
		return { kind: "ordinary" };
	}
	return /^\/wiki(?:\/|$)/.test(path) &&
		/(?:facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|Googlebot|bingbot)/i.test(userAgent) &&
		// A human WhatsApp WebView has a browser UA, not the preview bot UA.
		!(/WhatsApp/i.test(userAgent) && /(?:Mozilla\/|AppleWebKit\/)/i.test(userAgent))
		? { kind: "public_wiki_metadata" }
		: { kind: "ordinary" };
}
