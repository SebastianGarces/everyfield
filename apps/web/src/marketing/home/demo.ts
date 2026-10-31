import type { HeroDemo } from "../hero/HeroAnimation";
import type { MondayDemo } from "../visuals/MondayOverview";

// Demo data of the home page, as in the approved OPS-82 prototype (design/everyfield-marketing.html): Harvest Point
// Church, planter Daniel, a spring 2027 launch. Rachel Mitchell signed on Oct 6; vision meeting #12 is on Oct 12, where
// Emily Carter checks in; her follow-up task for Jen Park is due Oct 14. Evry creates follow-up tasks for people and
// never writes to the congregation.

/** The hero's cards: Emily Carter goes from the interest form to the core group (34 to 35). */
export const HERO: HeroDemo = {
	meeting: { title: "Vision meeting #12", sub: "Sun, Oct 12 · 6:00 PM" },
	task: {
		title: "Follow up with Emily Carter after vision meeting #12",
		assignee: "Jen Park",
		initials: "JP",
		due: "due Tue, Oct 14",
	},
	person: { name: "Emily Carter", first: "Emily", initials: "EC", following: [23, 22], core: [34, 35] },
};

export const MONDAY: MondayDemo = {
	title: "Good morning, Daniel",
	sub: "Harvest Point Church · Phase 1, Core Group Development · Launch target spring 2027",
	core: "Core team",
	lastMeeting: "16 d ago",
	nextMeeting: "Next Oct 12",
	focus: {
		num: "16 d",
		title: "Hold your next vision meeting this week",
		text: "Vision meeting #12 is set for Sun Oct 12. Invite the 9 guests from #11.",
	},
	coming: [
		["Vision meeting #12", "Sun Oct 12 · Reyes home · 38 RSVPs"],
		["Worship team training", "Wed Oct 15 · 8 of 9 confirmed"],
		["Interview David Kim", "Fri Oct 17 · 4 pm at the Reyes home"],
	],
	needs: [
		["3 follow-ups overdue", "James Okafor is the oldest at 3 days"],
		["2 commitments to record", "Rachel Mitchell signed on Oct 6"],
		["Kids ministry needs a leader", "2 of 6 roles filled"],
		["Reaffirm prayer rhythm", "Last answered 34 days ago"],
	],
};
