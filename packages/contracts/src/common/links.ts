// The one rule for which outside link addresses may stay links in user or agent Markdown. The task description
// normalizer (storage) and the Evry answer parser (render) both call it, so the two never disagree.

/** The trimmed address when it is http or https with a host, or mailto; otherwise null. */
export function safeLinkAddress(raw: string): string | null {
	const href = raw.trim();
	// Control characters and spaces hide schemes ("java\nscript:").
	if (!href || /[\u0000- \u007f-\u009f]/.test(href)) return null;
	return /^https?:\/\/[^/?#]/i.test(href) || /^mailto:[^\s]+$/i.test(href) ? href : null;
}
