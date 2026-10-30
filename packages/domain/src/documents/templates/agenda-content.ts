type AgendaSegment = { mins: number; name: string; note: string };
export type AgendaSpec = {
	title: string;
	subject: string;
	kicker: string;
	footer: string;
	purpose: (church: string) => string;
	segments: AgendaSegment[];
	/** Rows in each attendee column. */
	attendeeRows: number;
	actionRows: number;
	/** Whether pastor_name pre-fills the facilitator box. */
	facilitatorFromPastor: boolean;
};

export const VISION_AGENDA: AgendaSpec = {
	title: "Vision Meeting Agenda",
	subject: "Agenda for a vision meeting",
	kicker: "Core group  ·  Vision meeting",
	footer: "Vision meeting agenda",
	purpose: (church) =>
		`Share the vision for ${church}, a new church plant, and invite each guest to GROW, PRAY and GIVE.`,
	segments: [
		{
			mins: 10,
			name: "Welcome and prayer",
			note: "Greet every guest by name. Say why we meet: to share the vision for a new church plant. Open in prayer.",
		},
		{
			mins: 15,
			name: "Our story",
			note: "Tell why this church plant exists and what has happened so far. Keep it to one story.",
		},
		{
			mins: 20,
			name: "The vision",
			note: "Who we hope to reach, where we will gather and what a Sunday looks like. Invite questions on index cards.",
		},
		{
			mins: 20,
			name: "The ask: GROW, PRAY, GIVE",
			note: "GROW in a weekly group. PRAY for the church plant each week. GIVE time and money toward launch. Hand out commitment cards. No pressure.",
		},
		{
			mins: 15,
			name: "Next steps",
			note: "Collect cards. Book one-to-one coffees. Announce the date of the next vision meeting.",
		},
	],
	attendeeRows: 4,
	actionRows: 4,
	facilitatorFromPastor: true,
};

export const BOARD_AGENDA: AgendaSpec = {
	title: "Board and Elder Meeting Agenda",
	subject: "Agenda for a board or elder meeting",
	kicker: "Board and elders",
	footer: "Board and elder meeting agenda",
	purpose: (church) => `Pray, decide and assign action items for ${church}.`,
	segments: [
		{ mins: 5, name: "Opening prayer", note: "Open in prayer. Welcome any guest. Name anyone who cannot attend." },
		{
			mins: 10,
			name: "Approve the minutes",
			note: "Read the minutes of the last meeting. Correct them, then vote to approve.",
		},
		{
			mins: 20,
			name: "Financial report",
			note: "Review income, spending and the cash balance against the budget. Note anything off plan.",
		},
		{
			mins: 25,
			name: "Ministry updates",
			note: "One short report from each ministry lead. Name needs and decisions the board must make.",
		},
		{
			mins: 15,
			name: "Action items",
			note: "Read back each action with its owner and due date. Set the next meeting date.",
		},
	],
	attendeeRows: 4,
	actionRows: 4,
	facilitatorFromPastor: false,
};
