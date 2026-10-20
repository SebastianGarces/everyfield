// Invented sample data for /design/display. No real people, churches or numbers.
import type { Stage } from "../Badges";
import type { WikiPhase, WikiSource } from "../Content";
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
