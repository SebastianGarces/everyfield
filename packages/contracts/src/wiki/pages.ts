export const APP_PAGES = [
	{ route: "/overview", name: "Overview" },
	{ route: "/people", name: "People" },
	{ route: "/people/[personId]", name: "Person" },
	{ route: "/people/import", name: "People import" },
	{ route: "/people/duplicates", name: "People duplicates" },
	{ route: "/meetings", name: "Meetings" },
	{ route: "/meetings/[meetingId]", name: "Meeting" },
	{ route: "/communication", name: "Messages" },
	{ route: "/tasks", name: "Tasks" },
	{ route: "/tasks/follow-ups", name: "Follow-ups" },
	{ route: "/follow-ups/[taskId]", name: "Follow-up" },
	{ route: "/ministries", name: "Ministries" },
	{ route: "/ministries/[teamId]", name: "Ministry" },
	{ route: "/wiki", name: "Wiki" },
	{ route: "/launch", name: "Launch" },
	{ route: "/intelligence", name: "Plant Intelligence" },
	{ route: "/intelligence/attestations", name: "Plant Intelligence attestations" },
	{ route: "/intelligence/journey", name: "Plant Intelligence journey" },
	{ route: "/intelligence/trends", name: "Plant Intelligence trends" },
	{ route: "/documents", name: "Documents" },
	{ route: "/documents/church", name: "Church Documents" },
	{ route: "/documents/church/archived", name: "Archived Church Documents" },
	{ route: "/documents/church/[documentId]", name: "Church Document" },
	{ route: "/documents/written/[documentId]", name: "Written document" },
	{ route: "/notifications", name: "Notifications" },
	{ route: "/feedback", name: "Feedback" },
	{ route: "/feedback/[feedbackId]", name: "Feedback item" },
	{ route: "/settings", name: "Settings" },
	{ route: "/settings/church", name: "Church settings" },
	{ route: "/settings/brand", name: "Brand settings" },
	{ route: "/settings/notifications", name: "Notification settings" },
	{ route: "/settings/wiki", name: "Wiki settings" },
	{ route: "/settings/account", name: "Account settings" },
	{ route: "/settings/seats", name: "Seats" },
	{ route: "/settings/sharing", name: "Sharing" },
	{ route: "/my-residency", name: "My residency" },
	{ route: "/my-residency/reading/[readingId]", name: "Residency reading" },
] as const satisfies readonly { route: `/${string}`; name: string }[];

export type AppPage = (typeof APP_PAGES)[number];
export type AppRoute = AppPage["route"];
export const APP_ROUTES = APP_PAGES.map((page) => page.route) as [AppRoute, ...AppRoute[]];

const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const segments = (path: string) => path.split("/").filter(Boolean);

export function appPage(path: string): AppPage | null {
	const parts = segments(path.split(/[?#]/, 1)[0] ?? "");
	const fits = (page: AppPage) => {
		const pattern = segments(page.route);
		return (
			pattern.length === parts.length &&
			pattern.every((segment, index) => {
				const part = parts[index] ?? "";
				return segment === part || (segment.startsWith("[") && RECORD_ID.test(part));
			})
		);
	};
	return APP_PAGES.find(fits) ?? null;
}
