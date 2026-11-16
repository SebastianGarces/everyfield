export type AgendaSpec = {
	title: string;
	subject: string;
	kicker: string;
	footer: string;
	purpose: (church: string) => string;
	facilitatorFromPastor: boolean;
};

export const BLANK_RUN_ROWS = 6;
export const MIN_ATTENDEE_ROWS = 8;
export const ACTION_ROWS = 4;

export const VISION_AGENDA: AgendaSpec = {
	title: "Vision Meeting Agenda",
	subject: "Agenda for a vision meeting",
	kicker: "Core group  ·  Vision meeting",
	footer: "Vision meeting agenda",
	purpose: (church) =>
		`Share the vision for ${church}, a new church plant, and invite each guest to GROW, PRAY and GIVE.`,
	facilitatorFromPastor: true,
};

export const BOARD_AGENDA: AgendaSpec = {
	title: "Board and Elder Meeting Agenda",
	subject: "Agenda for a board or elder meeting",
	kicker: "Board and elders",
	footer: "Board and elder meeting agenda",
	purpose: (church) => `Pray, decide and assign action items for ${church}.`,
	facilitatorFromPastor: false,
};
