import type { Copy } from "../copy";
import type { HeroDemo } from "../hero/HeroAnimation";
import type { EvryDemo } from "../panels/intelligence";
import type { PhaseDemo } from "../rail/vignettes";
import type { MondayDemo } from "../visuals/MondayOverview";

// Demo data of the home page, on one timeline so every section agrees (Harvest Point Church, planter
// Daniel, Launch Sunday Sun, Mar 14, 2027, a winter launch):
//   Sun, Oct 4    vision meeting #11 at the Reyes home: 9 guests, 3 of them new (hero, week chapter)
//   Tue, Oct 6    Maria Santos signs her core group commitment; the new guests' follow-ups are due
//   Fri, Oct 9    Ana Reyes is interviewed; she signs on Fri, Oct 16
//   Mon, Oct 19   the Monday overview, the vision zoom's week and Plant Intelligence (core group 34, launch team 12);
//                 David Kim's interview is on Fri, Oct 23
//   Sun, Oct 25   vision meeting #12, which Evry sets up and you approve
// The strings the copy file owns (shared.panels) are passed in; the rest is panel data.

/** The hero's cards: meeting #11, and two lines that the Evry section and the overview say later in their own words. */
/** Maria Santos is the hero's person, so the core group goes 33 to 34, as in the week chapter and the overview. */
export const HERO: HeroDemo = {
	meeting: { title: "Vision meeting #11", sub: "Sun, Oct 4 · 6:00 PM" },
	draftSub: "Due today. Waiting for your approval.",
	peopleTitle: "Maria joins the core group",
	person: { name: "Maria Santos", initials: "MS", core: [33, 34] },
};
export const PEOPLE_TITLE = "Add people";
export const MEET_WHEN = "Sun, Oct 4, 6 pm";

export const followDemo = (p: Copy["shared"]["panels"]) => ({
	says: p.week_follow_says,
	after: "After vision meeting #11",
	due: "New guest · due Tue, Oct 6",
	note: "Assign each one to anyone on your team.",
	tasks: [
		["Interview Ana Reyes", "Fri, Oct 9"],
		["Record Maria Santos's commitment", "Signed on Oct 6"],
	] as const,
});

/** Team sizes before the two recordings: 33 + Maria Santos = 34 in the core group, 11 + James Park = 12 on the launch team. */
export const TEAM_SIZES = [33, 11] as const;
export const teamsDemo = (p: Copy["shared"]["panels"]) => ({
	teams: [
		["tone-green", p.monday_core_label, "var(--ef-green-500)", TEAM_SIZES[0]],
		["tone-violet", "Launch team", "var(--ef-violet-500)", TEAM_SIZES[1]],
	] as const,
	signs: [
		["MS", "Maria Santos", p.teams_sign_core],
		["JP", p.launch_team_member, "Joined the launch team"],
	] as const,
});

export const mondayDemo = (p: Copy["shared"]["panels"]): MondayDemo => ({
	title: p.monday_title,
	sub: p.monday_sub,
	core: p.monday_core_label,
	lastMeeting: "15 d ago",
	nextMeeting: "Next Oct 25",
	focus: {
		num: "15 d",
		title: "Hold your next vision meeting this week",
		text: "#12 is not set up yet. The 9 guests from #11 are waiting for an invitation.",
	},
	coming: [
		["Vision meeting #12", "Sun, Oct 25 · Not set up yet"],
		["Worship team training", "Wed, Oct 21 · 8 of 9 confirmed"],
		["Interview David Kim", "Fri, Oct 23 · 4 pm at the Reyes home"],
	],
	needs: [
		["3 follow-ups overdue", "James Okafor is the oldest, due Oct 6"],
		["2 commitments to record", "Ana Reyes signed on Oct 16"],
		["Children's ministry needs a leader", "2 of 6 roles filled"],
		["Reaffirm prayer rhythm", "Last answered 34 days ago"],
	],
});

export const phaseDemo = (p: Copy["shared"]["panels"]): PhaseDemo => ({
	areas: p.ministry_areas,
	training: ["Worship team", "Assimilation team", "Children's ministry"],
	milestones: "3 of 9 done",
	// The product area names are longer than the live labels; they wrap instead of truncating.
	wrap: true,
});

export const evryDemo = (e: Copy["journey"]["evry"]["example"]): EvryDemo => {
	const [head, action, buttons] = e.review.split(" · ") as [string, string, string];
	const [approve = "Approve", edit = "Edit"] = buttons.split(" or ");
	return {
		q: e.ask,
		a: e.answer,
		review: [head, action],
		meeting: { name: "Vision meeting #12", when: "Sun, Oct 25", where: "Reyes home" },
		rest: "The 90-minute agenda, 9 guests and the invitation email",
		approve,
		edit,
	};
};

/** The plants Grace Church sends (the sending glimpse). Values match the /oversight demo rows. */
export const SENT = [
	["Harvest Point Church", "Phase 1 · Core group", "Launch Sunday Mar 14, 2027"],
	["Eastside Commons", "Phase 3 · Training", "Launch Sunday May 2, 2027"],
] as const;
