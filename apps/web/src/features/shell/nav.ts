import {
	BookOpen01Icon,
	Calendar03Icon,
	ChartLineData01Icon,
	DashboardSquare01Icon,
	File02Icon,
	FileSearchIcon,
	HierarchyIcon,
	Link01Icon,
	Mail01Icon,
	Mortarboard01Icon,
	Notification03Icon,
	Route01Icon,
	StartUp02Icon,
	ShieldUserIcon,
	Task01Icon,
	UserGroupIcon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { DASHBOARD_HOME } from "@everyfield/contracts/identity";
import type { ShellLink } from "@everyfield/ui/shell";

const OVERVIEW = {
	kind: "link",
	key: "overview",
	label: "Overview",
	href: DASHBOARD_HOME,
	icon: DashboardSquare01Icon,
	prefetch: false,
} as const;
const PEOPLE = { kind: "link", key: "people", label: "People", href: "/people", icon: UserMultipleIcon } as const;
const MEETINGS = {
	kind: "link",
	key: "meetings",
	label: "Meetings",
	href: "/meetings",
	icon: Calendar03Icon,
	prefetch: false,
} as const;
const TASKS = { kind: "link", key: "tasks", label: "Tasks", href: "/tasks", icon: Task01Icon } as const;
const MESSAGES = {
	kind: "link",
	key: "messages",
	label: "Messages",
	href: "/communication",
	icon: Mail01Icon,
	prefetch: false,
} as const;
const MINISTRIES = {
	kind: "link",
	key: "ministries",
	label: "Ministries",
	href: "/ministries",
	icon: UserGroupIcon,
	prefetch: false,
} as const;
const WIKI = { kind: "link", key: "wiki", label: "Wiki", href: "/wiki", icon: BookOpen01Icon } as const;
const DOCUMENTS = {
	kind: "link",
	key: "documents",
	label: "Documents",
	href: "/documents",
	icon: File02Icon,
	prefetch: false,
} as const;
const INTELLIGENCE = {
	kind: "link",
	key: "intelligence",
	label: "Plant Intelligence",
	href: "/intelligence",
	icon: ChartLineData01Icon,
	prefetch: false,
} as const;
const LAUNCH = {
	kind: "link",
	key: "launch",
	label: "Launch",
	href: "/launch",
	icon: StartUp02Icon,
	prefetch: false,
} as const;
const PLANTS = { kind: "link", key: "plants", label: "Plants", href: "/network", icon: HierarchyIcon } as const;
const ORGANIZATION_PAGES = [
	{ kind: "link", key: "connections", label: "Connections", href: "/settings/sharing#connections", icon: Link01Icon },
	{ kind: "link", key: "sharing", label: "Sharing", href: "/settings/sharing", icon: ShieldUserIcon },
	{ kind: "link", key: "notifications", label: "Notifications", href: "/notifications", icon: Notification03Icon },
] as const;
const PIPELINE = {
	kind: "link",
	key: "pipeline",
	label: "Pipeline",
	href: "/organization/pipeline",
	icon: Route01Icon,
	prefetch: false,
} as const;
const REVIEWS = {
	kind: "link",
	key: "reviews",
	label: "Sent for review",
	href: "/organization/reviews",
	icon: FileSearchIcon,
	prefetch: false,
} as const;
const MY_RESIDENCY = {
	kind: "link",
	key: "my-residency",
	label: "My residency",
	href: "/my-residency",
	icon: Mortarboard01Icon,
} as const;

export type NavViewer =
	| { context: "plant"; role: "owner" | "admin" | "member" }
	| { context: "organization" }
	| { context: "account"; residencyLinked: boolean }
	| { context: "pending" };

export type RailNav = { main: readonly ShellLink[]; pages: readonly ShellLink[]; guide: boolean };

export function shellNav(viewer: NavViewer): RailNav {
	if (viewer.context === "organization")
		return { main: [PLANTS, PIPELINE, REVIEWS], pages: ORGANIZATION_PAGES, guide: false };
	if (viewer.context === "pending") return { main: [DOCUMENTS], pages: [], guide: false };
	if (viewer.context === "account")
		return { main: viewer.residencyLinked ? [MY_RESIDENCY, WIKI] : [WIKI], pages: [DOCUMENTS], guide: true };
	return {
		main: [OVERVIEW, PEOPLE, MEETINGS, MESSAGES, TASKS, MINISTRIES, WIKI],
		pages: viewer.role === "member" ? [LAUNCH, DOCUMENTS] : [LAUNCH, INTELLIGENCE, DOCUMENTS],
		guide: true,
	};
}
