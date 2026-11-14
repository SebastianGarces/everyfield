// The words Evry's seat, sharing and time zone reviews use, shared by the adapters, the scripted model and the web
// review card (`@everyfield/evry/labels`). Plain constants with no imports, so a client component can use them.

/** A seat's role as people read it. */
export const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member" } as const;

/** What a church can share with a connected organization, as Evry names each category. */
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

/** The common US time zones by their everyday names. */
export const ZONE_NAME: Readonly<Record<string, string>> = {
	"America/New_York": "Eastern",
	"America/Chicago": "Central",
	"America/Denver": "Mountain",
	"America/Phoenix": "Arizona",
	"America/Los_Angeles": "Pacific",
	"America/Anchorage": "Alaska",
	"Pacific/Honolulu": "Hawaii",
};

/** The seven phases by the names `/onboarding` shows. */
export const PHASE_NAME = [
	"Discovery",
	"Core group development",
	"Launch team formation",
	"Training and preparation",
	"Pre-launch",
	"Launch Sunday",
	"Post-launch",
] as const;
/** "Phase 1, Core group development". */
export const phaseText = (phase: number) => `Phase ${phase}, ${PHASE_NAME[phase] ?? "unknown"}`;
