import type { Area } from "@everyfield/contracts/launch";

// The nine Launch Playbook readiness milestones and their 23 prep tasks (LCH-003), as fixed data. Titles, descriptions
// and keys are those of docs/reference/launch-milestone-templates.ts, counted in docs/reference/launch-template-inventory.json;
// tests/integration/launch/launch.test.mts compares them. Code matches on `key`, never on a title. A prep task's seed
// identity is `<milestone key>/<n>`, its place in the milestone, starting at 1.

export type MilestoneTemplate = {
	key: string;
	area: Area;
	title: string;
	description: string;
	tasks: readonly string[];
};

export const MILESTONES: readonly MilestoneTemplate[] = [
	{
		key: "operations.equipment_on_site",
		area: "operations",
		title: "Set-up equipment on site",
		description:
			"Every piece of set-up equipment needed to launch arrives during the three-to-four week window, stored and labelled.",
		tasks: [
			"Order the remaining set-up equipment",
			"Confirm delivery dates for everything still outstanding",
			"Label and store the equipment where the team will find it",
		],
	},
	{
		key: "operations.setup_training",
		area: "operations",
		title: "Set-up and tear-down training held",
		description:
			"A full Saturday of in-service training: hands-on set-up and tear-down, storage, care of equipment, and working as teams.",
		tasks: [
			"Book the full-Saturday in-service training",
			"Walk the team through set-up, tear-down and storage",
			"Test and improve Worship Center acoustics and lighting",
		],
	},
	{
		key: "operations.worship_center",
		area: "operations",
		title: "Worship Center secured and rehearsed in",
		description:
			"The room is secured for set-up, tear-down and launch-team meetings — optimally used three times before Launch Sunday.",
		tasks: ["Confirm the Worship Center booking", "Schedule three uses of the room before Launch Sunday"],
	},
	{
		key: "launch_team.prayer_and_fasting",
		area: "launch_team",
		title: "Prayer and fasting underway",
		description:
			"One day a week of fasting through the four weeks before launch, ending in corporate worship, prayer and a shared meal. The senior pastor leads it.",
		tasks: [
			"Set the weekly fast day for the four weeks before launch",
			"Plan the worship, prayer and shared meal that close each fast",
		],
	},
	{
		key: "launch_team.pre_launch_services",
		area: "launch_team",
		title: "Three pre-launch services held",
		description:
			"Launch-team-only services on the three Sundays (or Saturdays) before launch: set-up, worship, preaching, children's ministry, assimilation, celebration.",
		tasks: [
			"Book the Worship Center for three pre-launch services",
			"Run pre-launch service 1",
			"Run pre-launch services 2 and 3",
		],
	},
	{
		key: "launch_team.ministry_training",
		area: "launch_team",
		title: "Ministry training 90–100% complete",
		description:
			"Specific ministry training should be all but finished before the final window — this is the time to integrate the parts into the whole.",
		tasks: [
			"Finish children's ministry training: teachers, curriculum, check-in, safety",
			"Finish the worship team run-through",
			"Test assimilation end to end",
		],
	},
	{
		key: "promotion.plan",
		area: "promotion",
		title: "Promotion plan chosen",
		description:
			"A well-thought-out, prayerful plan sized to the plant's financial condition — not every channel in the Playbook, the right ones.",
		tasks: ["Choose the promotion channels your budget supports", "Set the launch team's personal invitation goal"],
	},
	{
		key: "promotion.implemented",
		area: "promotion",
		title: "Promotion plan implemented",
		description:
			"Three to four weeks out triggers the full launch of the promotion plan — get the word out by every means the plan named.",
		tasks: [
			"Send the press release to local media",
			"Run the email blast and social posts",
			"Distribute invitation cards, door hangers and mailers",
		],
	},
	{
		key: "promotion.partner_churches",
		area: "promotion",
		title: "Partner churches announcing the launch",
		description:
			"The week before launch, every partner church shows the announcement slide — and the partner organization's role in the service is settled.",
		tasks: [
			"Email the launch announcement slide to every partner church",
			"Confirm the partner organization's role in the service",
		],
	},
];

/** Every milestone and prep task as seed rows: one entry per milestone, its position and its keyed tasks. */
export const SEED = MILESTONES.map((m, i) => ({
	...m,
	position: i + 1,
	taskKeys: m.tasks.map((title, n) => ({ key: `${m.key}/${n + 1}`, title })),
}));
