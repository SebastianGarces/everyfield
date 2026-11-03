// The Guide's screen-to-article list (WP-034), from Nora's list of Nov 2, 2026. A route outside this list has no
// Guide. Each entry names a global article slug and one exact heading in it, so it resolves against whichever Wiki
// release is current. A bracketed segment matches one record id, which is always a UUID: `/people/duplicates` is a
// screen of its own, not a person.

export type GuideEntry = { readonly route: `/${string}`; readonly slug: string; readonly heading: string };

export const GUIDE_ROUTES = [
	{ route: "/people", slug: "core-group/follow-up/database-management", heading: "What to Track" },
	{ route: "/people/[personId]", slug: "core-group/follow-up/database-management", heading: "Status Categories" },
	{ route: "/people/import", slug: "core-group/follow-up/database-management", heading: "After Each Vision Meeting" },
	{
		route: "/meetings",
		slug: "core-group/vision-meetings/what-is-a-vision-meeting",
		heading: "Seven Essential Elements",
	},
	{
		route: "/meetings/[meetingId]",
		slug: "core-group/vision-meetings/planning-your-vision-meeting",
		heading: "Building Your Agenda",
	},
	{
		route: "/tasks/follow-ups",
		slug: "core-group/follow-up/the-importance-of-great-follow-up",
		heading: "The Follow-Up Process",
	},
	{
		route: "/follow-ups/[taskId]",
		slug: "core-group/follow-up/4-reasons-follow-up-is-vital",
		heading: "Putting It All Together",
	},
	{ route: "/ministries", slug: "training/goals-by-launch-sunday", heading: "Ministry Teams to Establish" },
	{
		route: "/ministries/[teamId]",
		slug: "launch-team/leadership/key-leadership-roles-overview",
		heading: "Finding the Right People",
	},
	{
		route: "/documents",
		slug: "core-group/commitment/the-three-key-documents",
		heading: "Overview of the Three Documents",
	},
	{
		route: "/documents/church",
		slug: "core-group/commitment/the-three-key-documents",
		heading: "Overview of the Three Documents",
	},
	{
		route: "/settings/brand",
		slug: "administrative/technology/building-your-churchs-brand",
		heading: "Choose colors and type people can read",
	},
	{
		route: "/intelligence",
		slug: "getting-started/welcome-to-the-launch-playbook",
		heading: "How to Navigate the Playbook",
	},
] as const satisfies readonly GuideEntry[];

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function segments(path: string): string[] {
	return path.split("/").filter(Boolean);
}

/** The registry entry for an app address. A query string, a fragment or a trailing slash does not change it. */
export function guideFor(route: string): GuideEntry | null {
	const parts = segments(route.split(/[?#]/, 1)[0] ?? "");
	return (
		GUIDE_ROUTES.find((entry) => {
			const pattern = segments(entry.route);
			return (
				pattern.length === parts.length &&
				pattern.every((segment, index) => {
					const part = parts[index] ?? "";
					return segment.startsWith("[") ? RECORD_ID.test(part) : segment === part;
				})
			);
		}) ?? null
	);
}

export const EXCERPT_LIMIT = 500;

type Node = {
	type?: unknown;
	level?: unknown;
	text?: unknown;
	children?: unknown;
	content?: unknown;
	items?: unknown;
	rows?: unknown;
	blocks?: unknown;
};

function inline(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(inline).join("");
	if (!value || typeof value !== "object") return "";
	const node = value as Node;
	if (typeof node.text === "string") return node.text;
	return inline(node.children ?? node.content ?? "");
}

/** Organization nodes as markdown lines: headings keep their level, list items and table rows one line each. */
function nodeLines(value: unknown, out: string[]): void {
	if (Array.isArray(value)) {
		for (const item of value) nodeLines(item, out);
		return;
	}
	if (!value || typeof value !== "object") return;
	const node = value as Node;
	const level = node.type === "h2" ? 2 : node.type === "h3" ? 3 : node.level;
	if (node.type === "heading" || node.type === "h2" || node.type === "h3" || level === 2 || level === 3) {
		out.push(`${"#".repeat(level === 3 ? 3 : 2)} ${inline(node).trim()}`);
		return;
	}
	if (Array.isArray(node.items)) {
		for (const item of node.items) out.push(`- ${inline(item).trim()}`);
		return;
	}
	if (Array.isArray(node.rows)) {
		for (const row of node.rows) out.push(Array.isArray(row) ? row.map((cell) => inline(cell).trim()).join(" · ") : "");
		return;
	}
	if (node.blocks !== undefined) return nodeLines(node.blocks, out);
	const text = inline(node).trim();
	if (text) out.push(text);
}

function bodyLines(contentType: string, body: string): string[] {
	if (contentType === "safe_nodes") {
		try {
			const lines: string[] = [];
			nodeLines(JSON.parse(body), lines);
			return lines;
		} catch {
			// Older organization text is plain text, not nodes.
		}
	}
	return body.split("\n");
}

/**
 * The section under `heading`, up to the next heading of the same or higher level, cut at 500 characters. Without
 * the heading, the start of the text. Excerpts are never reading.
 */
export function sectionExcerpt(contentType: string, body: string, heading?: string): string {
	const lines = bodyLines(contentType, body);
	const start = heading ? lines.findIndex((line) => line.replace(/^#{1,6}\s*/, "").trim() === heading) : -1;
	const opening = lines[start];
	if (start < 0 || opening == null) return lines.join("\n").slice(0, EXCERPT_LIMIT);
	const level = /^(#+)\s/.exec(opening)?.[1]?.length ?? 2;
	const taken = [opening];
	for (const line of lines.slice(start + 1)) {
		const next = /^(#+)\s/.exec(line)?.[1]?.length;
		if (next != null && next <= level) break;
		taken.push(line);
	}
	return taken.join("\n").slice(0, EXCERPT_LIMIT);
}
