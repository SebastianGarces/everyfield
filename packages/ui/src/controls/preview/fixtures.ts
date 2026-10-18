import type { ComboboxOption, DatePreset, SelectOption } from "..";

// Invented sample data for the controls preview: one church, Harvest Point, as in the prototype.

/** Initials-circle tones for the preview. The real Avatar ships with WP-090. */
export const TONES_PREVIEW = {
	blue: "bg-blue-100 text-blue-600",
	amber: "bg-amber-100 text-amber-600",
	green: "bg-green-100 text-green-700",
	violet: "bg-violet-100 text-violet-600",
	magenta: "bg-magenta-100 text-magenta-600",
} as const;

type PreviewTone = keyof typeof TONES_PREVIEW;

export const ACTIVITY: { initials: string; tone: PreviewTone; title: string; sub: string }[] = [
	{ initials: "MS", tone: "blue", title: "Maria Santos RSVP'd", sub: "Vision meeting · 2h" },
	{ initials: "JO", tone: "amber", title: "James Okafor interviewed", sub: "by Daniel · 5h" },
	{ initials: "AL", tone: "green", title: "Ana Lee committed", sub: "Core group · 1d" },
	{ initials: "TB", tone: "violet", title: "Tom Baker joined Worship", sub: "Vocalist · 2d" },
	{ initials: "KW", tone: "magenta", title: "Kim Wu follow-up overdue", sub: "3 days late" },
	{ initials: "SN", tone: "blue", title: "Sara Nunez RSVP'd", sub: "Vision meeting · 3d" },
];

export const STAGES: (SelectOption & ComboboxOption)[] = [
	{ value: "prospect", label: "Prospect" },
	{ value: "attendee", label: "Attendee" },
	{ value: "following", label: "Following up" },
	{ value: "interviewed", label: "Interviewed" },
	{ value: "core", label: "Core group" },
	{ value: "launch", label: "Launch team" },
	{ value: "leader", label: "Leader" },
];

export const TAGS: { tags: ComboboxOption[]; owners: ComboboxOption[] } = {
	tags: [
		{ value: "hyde-park", label: "Hyde Park" },
		{ value: "east-austin", label: "East Austin" },
		{ value: "young-families", label: "Young families" },
		{ value: "students", label: "Students" },
	],
	owners: [
		{ value: "tom", label: "Tom Baker", description: "Worship" },
		{ value: "ana", label: "Ana Lee", description: "Hospitality" },
		{ value: "daniel", label: "Daniel Reyes", description: "Lead planter" },
		{ value: "kim", label: "Kim Wu", description: "Children" },
	],
};

export const PRESETS: DatePreset[] = [
	{ key: "7", label: "Last 7 days", range: { start: "2026-10-12", end: "2026-10-18" } },
	{ key: "28", label: "Last 28 days", range: { start: "2026-09-21", end: "2026-10-18" } },
	{ key: "90", label: "Last 90 days", range: { start: "2026-07-21", end: "2026-10-18" } },
];

export const COMMANDS: {
	heading: string;
	items: { id: string; label: string; meta?: string; initials?: string; tone?: PreviewTone; evry?: boolean }[];
}[] = [
	{
		heading: "People",
		items: [
			{ id: "p-maria", label: "Maria Santos", meta: "Interviewed", initials: "MS", tone: "blue" },
			{ id: "p-marcus", label: "Marcus Reed", meta: "Core group", initials: "MR", tone: "amber" },
			{ id: "p-ana", label: "Ana Lee", meta: "Core group", initials: "AL", tone: "green" },
		],
	},
	{
		heading: "Meetings",
		items: [{ id: "m-vision", label: "Vision meeting, Oct 26", meta: "18 RSVPs", initials: "VM", tone: "violet" }],
	},
	{ heading: "Ask Evry", items: [{ id: "e-1", label: "Who has Maria not met yet?", evry: true }] },
];
