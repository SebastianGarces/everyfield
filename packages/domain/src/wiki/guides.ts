import { appPage, type AppRoute } from "@everyfield/contracts/wiki";

export type GuideEntry = { readonly route: AppRoute; readonly slug: string; readonly heading: string };

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

export function guideFor(path: string): GuideEntry | null {
	const page = appPage(path);
	return GUIDE_ROUTES.find((entry) => entry.route === page?.route) ?? null;
}
