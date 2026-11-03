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
