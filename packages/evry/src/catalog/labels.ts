export const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member" } as const;

export const SHARING_CATEGORY_LABEL = {
	people: "People totals",
	meetings: "Meetings",
	tasks: "Tasks",
	ministry_teams: "Ministry teams",
	wiki: "Wiki",
	activity: "Activity updates",
	shared_findings: "Plant Intelligence findings",
} as const;
export type SharingCategory = keyof typeof SHARING_CATEGORY_LABEL;
export const SHARING_CATEGORIES = Object.keys(SHARING_CATEGORY_LABEL) as [SharingCategory, ...SharingCategory[]];

export const ZONE_NAME: Readonly<Record<string, string>> = {
	"America/New_York": "Eastern",
	"America/Chicago": "Central",
	"America/Denver": "Mountain",
	"America/Phoenix": "Arizona",
	"America/Los_Angeles": "Pacific",
	"America/Anchorage": "Alaska",
	"Pacific/Honolulu": "Hawaii",
};

const PHASE_NAME = [
	"Discovery",
	"Core group development",
	"Launch team formation",
	"Training and preparation",
	"Pre-launch",
	"Launch Sunday",
	"Post-launch",
] as const;
export const phaseText = (phase: number) => `Phase ${phase}, ${PHASE_NAME[phase] ?? "unknown"}`;

const part = (at: Date, zone: string, options: Intl.DateTimeFormatOptions) =>
	new Intl.DateTimeFormat("en-US", { ...options, timeZone: zone }).format(at);
export function localWhen(instant: string, zone: string) {
	const at = new Date(instant);
	return `${part(at, zone, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}, ${part(at, zone, {
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	})}`;
}

export const TYPE_LABEL: Record<string, string> = {
	vision_meeting: "Vision meeting",
	orientation: "Orientation",
	team_meeting: "Team meeting",
	prelaunch_practice: "Pre-launch practice",
};
