export function safeLinkAddress(raw: string): string | null {
	const href = raw.trim();
	if (!href || /[\u0000- \u007f-\u009f]/.test(href)) return null;
	return /^https?:\/\/[^/?#]/i.test(href) || /^mailto:[^\s]+$/i.test(href) ? href : null;
}
