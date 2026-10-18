// Invented sample data for /design/display. No real people, churches or numbers.
import type { Stage } from "../Badges";
import type { BarDatum, DotColumn, JourneyPhase } from "../Charts";
import type { WikiPhase, WikiSource } from "../Content";
import type { AreaRow, CheckinQuestion, CheckinWeek, DocTemplate, MergeFieldRow } from "../Records";
import type { Tone } from "../tone";

export type Person = {
	id: string;
	name: string;
	household: string;
	tone: Tone;
	stage: Stage;
	lastContact: string;
	overdue?: boolean;
	ministry: { name: string; tone: Tone } | null;
	meetings: number;
};

export const PEOPLE: Person[] = [
	{
		id: "maria",
		name: "Maria Santos",
		household: "Santos household",
		tone: "blue",
		stage: "interviewed",
		lastContact: "Oct 3",
		ministry: { name: "Worship", tone: "green" },
		meetings: 5,
	},
	{
		id: "james",
		name: "James Okafor",
		household: "Invited by Ana Lee",
		tone: "amber",
		stage: "following",
		lastContact: "Sep 24 · 14 d",
		overdue: true,
		ministry: null,
		meetings: 2,
	},
	{
		id: "ana",
		name: "Ana Lee",
		household: "Lee household",
		tone: "green",
		stage: "core",
		lastContact: "Oct 6",
		ministry: { name: "Hospitality", tone: "blue" },
		meetings: 9,
	},
];

export const ATTENDANCE: BarDatum[] = [
	{ label: "Jun 1", value: 19, detail: "19 attended" },
	{ label: "Jun 15", value: 22, detail: "22 attended · 4 new" },
	{ label: "Jun 29", value: 21, detail: "21 attended · 1 new" },
	{ label: "Jul 13", value: 26, detail: "26 attended · 6 new" },
	{ label: "Jul 27", value: 28, detail: "28 attended · 3 new" },
	{ label: "Aug 10", value: 25, detail: "25 attended · 2 new" },
	{ label: "Aug 24", value: 31, detail: "31 attended · 7 new" },
	{ label: "Sep 7", value: 33, detail: "33 attended · 4 new" },
	{ label: "Sep 21", value: 35, detail: "35 attended · 5 new" },
	{ label: "Sep 28", value: 39, detail: "39 attended · 9 new" },
];

export const RETURN_VISITS: DotColumn[] = [
	{ label: "1 visit, lost", count: 7, tone: "magenta" },
	{ label: "2 visits, at risk", count: 9, tone: "amber" },
	{ label: "3 visits, at risk", count: 5, tone: "amber" },
	{ label: "4 visits, returning", count: 6, tone: "blue" },
	{ label: "5 visits, returning", count: 4, tone: "blue" },
	{ label: "6 visits, committed", count: 8, tone: "green" },
	{ label: "7 visits, committed", count: 10, tone: "green" },
	{ label: "8 or more visits, committed", count: 13, tone: "green" },
];

export const SERVING = {
	columns: ["Jul", "Aug", "Sep", "Oct"],
	rows: [
		{ label: "Worship", values: [14, 11, 10, 7] },
		{ label: "Hospitality", values: [9, 6, 6, 3] },
		{ label: "Kids", values: [2, 3, 1, 0] },
	],
};

export const JOURNEY: JourneyPhase[] = [
	{ name: "Discovery", state: "done", weeks: "10 wk", range: "Playbook 8 to 12" },
	{ name: "Core group", state: "done", weeks: "34 wk", range: "Playbook 24 to 40" },
	{ name: "Launch team", state: "done", weeks: "18 wk", range: "Playbook 12 to 20" },
	{ name: "Training", state: "current", weeks: "6 wk so far", range: "Playbook 8 to 12", progress: 0.55 },
	{ name: "Pre-launch", state: "next", range: "Playbook 10 to 14" },
	{ name: "Launch Sunday", state: "next", weeks: "May 2" },
	{ name: "Post-launch", state: "next" },
];

export const PIPELINE = [
	{ name: "Discovery", count: 1, typical: "6 wk" },
	{ name: "Core group", count: 4, typical: "31 wk" },
	{ name: "Launch team", count: 3, typical: "15 wk" },
	{ name: "Training", count: 2, typical: "9 wk" },
	{ name: "Pre-launch", count: 2, typical: "11 wk" },
	{ name: "Launch Sunday", count: 0 },
	{ name: "Post-launch", count: 2 },
];

const MONTHS = ["Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"];
const LAUNCHES: Record<number, string[]> = {
	2: ["Deep Ellum Collective"],
	4: ["Harvest Point Church"],
	6: ["Eastside Commons"],
	7: ["Lakewood Gathering"],
	10: ["Alamo Heights Church", "River Oaks Fellowship"],
};
export const CALENDAR = MONTHS.map((month, i) => ({ month, plants: LAUNCHES[i] ?? [] }));

export const WIKI_PHASES: WikiPhase[] = [
	{ number: 0, name: "Discovery", items: [{ id: "call", title: "Discern the call", href: "#discern", read: true }] },
	{
		number: 1,
		name: "Core Group Development",
		items: [
			{ id: "vision", title: "Cast the vision", href: "#cast", read: true },
			{ id: "first", title: "Run your first vision meeting", href: "#first" },
			{ id: "follow", title: "Follow up within 48 hours", href: "#follow", read: true },
			{ id: "interview", title: "Interview potential members", href: "#interview" },
		],
	},
	{
		number: 2,
		name: "Launch Team Formation",
		items: [{ id: "roles", title: "Fill the leader roles", href: "#roles" }],
	},
];

export const SOURCES: WikiSource[] = [
	{
		id: "asn",
		short: "AS",
		name: "Austin Sending Network",
		meta: "Edited version 3 · published Sep 12",
		kind: "network",
	},
	{ id: "hcn", short: "HC", name: "Hill Country Network", meta: "Edited version 1 · Aug 30", kind: "network" },
	{ id: "ef", short: "EF", name: "Everyfield global", meta: "Version 5 · Oct 2", kind: "global" },
];

export const FAQ = [
	{
		id: "wiki-help",
		question: "What is the difference between the Wiki and Help?",
		answer:
			"The Wiki teaches the church-planting method: what to do in each phase and why. Help explains how to use Everyfield.",
	},
	{
		id: "evry",
		question: "Can Evry change my records on its own?",
		answer: "No. Evry can read and draft. Every change it suggests waits for you to review and approve it.",
	},
	{
		id: "zero",
		question: "Why does a count show “Not recorded” instead of 0?",
		answer:
			"“Not recorded” means nobody entered a number yet. A 0 is a real result, for example a meeting with no guests.",
	},
];

export const DOCS: DocTemplate[] = [
	{
		id: "response",
		name: "Response card",
		description: "Guest contact and how they want to get involved.",
		stage: "Vision meetings · Phase 1",
		formats: ["pdf"],
		thumb: "quarter",
		tone: "magenta",
	},
	{
		id: "signin",
		name: "Guest sign-in sheet",
		description: "Names, contact and who invited each guest.",
		stage: "Vision meetings · Phase 1",
		formats: ["pdf", "xlsx"],
		thumb: "sheet",
		tone: "magenta",
	},
	{
		id: "budget",
		name: "First-year budget",
		description: "Income, giving and launch costs by month.",
		stage: "Administrative · Phase 2",
		formats: ["xlsx"],
		thumb: "grid-sheet",
		tone: "green",
	},
	{
		id: "values",
		name: "Core values",
		description: "The values your core group commits to.",
		stage: "Commitment · Phase 1",
		formats: ["docx", "pdf"],
		thumb: "page",
		tone: "blue",
	},
];

export const CHECKIN_QUESTIONS: CheckinQuestion[] = [
	{ id: "spirit", title: "Spiritually", prompt: "How is your own walk with God?" },
	{ id: "family", title: "Marriage and family", prompt: "How are things at home?" },
	{ id: "money", title: "Financially", prompt: "How are your personal finances?" },
	{ id: "pace", title: "Pace", prompt: "Is the pace sustainable?" },
];

export const CHECKIN_WEEKS: Omit<CheckinWeek, "onCorrect">[] = [
	{ week: "Oct 5", note: "this week", values: ["steady", "steady", "strained", "strained"] },
	{ week: "Sep 28", values: ["steady", "steady", "strained", "steady"] },
	{
		week: "Sep 21",
		note: "Corrected Sep 24 · Pace was Strained",
		corrected: true,
		values: ["strained", "steady", "struggling", "steady"],
	},
	{ week: "Sep 14", values: [null, null, null, null] },
];

export const MERGE_FIELDS: MergeFieldRow[] = [
	{
		id: "name",
		label: "Name",
		keep: "James Okafor",
		remove: "Jim Okafor",
		keepText: "James Okafor",
		removeText: "Jim Okafor",
	},
	{
		id: "email",
		label: "Email",
		keep: "james.okafor@example.org",
		remove: "j.okafor@example.com",
		keepText: "james.okafor@example.org",
		removeText: "j.okafor@example.com",
	},
	{ id: "phone", label: "Phone", keep: "(512) 555-0188", remove: null, keepText: "(512) 555-0188", removeText: "none" },
	{
		id: "household",
		label: "Household",
		keep: "Okafor household",
		remove: null,
		keepText: "Okafor household",
		removeText: "none",
	},
];

export const PHASES = [
	{ number: 0, name: "Discovery", description: "Discerning the call, values and readiness" },
	{ number: 1, name: "Core group development", description: "Vision meetings, follow-up, building commitment" },
	{ number: 2, name: "Launch team formation", description: "Launch date set, leaders filling roles" },
	{ number: 3, name: "Training and preparation", description: "Training teams and testing systems" },
	{ number: 4, name: "Pre-launch", description: "Pre-launch services and promotion" },
];

export const AREAS: AreaRow[] = [
	{
		area: "Austin metro",
		plants: 6,
		sharing: 5,
		lenses: [
			{ status: "attention", label: "Watch" },
			{ status: "positive", label: "Strong" },
		],
		gap: "Emerging leadership",
	},
	{
		area: "Dallas–Fort Worth",
		plants: 5,
		sharing: 4,
		lenses: [
			{ status: "risk", label: "Concern" },
			{ status: "attention", label: "Watch" },
		],
		gap: "Kids ministry leader",
	},
	{ area: "Greater Houston", plants: 1, sharing: 1, lenses: ["few", "few"], gap: null },
];
