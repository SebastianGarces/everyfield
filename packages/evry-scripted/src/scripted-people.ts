import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { counted, countWord, dayText } from "@everyfield/contracts/common";
import { call, say, turnOf, type Content, type Output, type Row } from "./scripted-turn.ts";

const CATEGORIES: [category: string, label: string, words: RegExp][] = [
	["tech", "Tech", /\b(tech|technical|sound|audio|video|av|lighting|slides)\b/i],
	["worship", "Worship", /\b(worship|music|musical|vocals?|singing|instruments?)\b/i],
	["admin", "Admin", /\b(admin|administrative|office)\b/i],
	["teaching", "Teaching", /\b(teaching|teach|preaching)\b/i],
	["hospitality", "Hospitality", /\b(hospitality|welcome|greeting)\b/i],
	["leadership", "Leadership", /\b(leadership|leading)\b/i],
];
const STAGES = ["prospect", "attendee", "following_up", "interviewed", "core_group", "launch_team", "leader"] as const;
const SKILLS = /\bskill(s|ed)?\b/i;
const NO_PHOTO = /\b(no|without|doesn['’]?t have|don['’]?t have|missing)\b[^.?!]{0,20}\b(photo|picture)s?\b/i;
const NO_HOUSEHOLD = /\b(isn['’]?t|aren['’]?t|not|no one)\b[^.?!]{0,10}\bin (any|a) household\b/i;
const CHILDREN = /\b(which|what|any) households?\b[^.?!]{0,30}\b(kids|children|child)\b/i;
const MOVED = /\bmoved? (?:in)?to (?:the )?([a-z ]+?) (?:stage )?this month\b/i;

const localToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
const and = (items: string[]) => new Intl.ListFormat("en-US", { type: "conjunction" }).format(items);

type Ask = {
	input: Record<string, unknown>;
	answer: (out: Output, rows: Row[], inChurch: number) => string;
	names?: true;
};

function asked(text: string): Ask | null {
	const skills = SKILLS.test(text) ? CATEGORIES.filter(([, , words]) => words.test(text)) : [];
	if (skills.length) {
		const wanted = new Set(skills.map(([c]) => c));
		const label = and(skills.map(([, l]) => l));
		return {
			input: { skillCategories: [...wanted] },
			names: true,
			answer: (out, rows, inChurch) => {
				const total = Number(out.total);
				if (!total) return `None of the ${inChurch} people in this church have a ${label} skill recorded.`;
				const held = rows.map((r) => `${r.label} (${matchedSkills(r, wanted)})`);
				return `${total} of the ${inChurch} people in this church have a ${label} skill recorded: ${and(held)}. That covers all ${inChurch} people in this church.`;
			},
		};
	}
	if (NO_PHOTO.test(text))
		return {
			input: { hasPhoto: false },
			answer: (out, _, inChurch) => `${String(out.total)} of the ${inChurch} people in this church have no photo.`,
		};
	if (NO_HOUSEHOLD.test(text))
		return {
			input: { inHousehold: false },
			answer: (out, _, inChurch) =>
				`${String(out.total)} of the ${inChurch} people in this church are in no household.`,
		};
	if (CHILDREN.test(text))
		return {
			input: { adultClassification: "child" },
			names: true,
			answer: (_, rows) => {
				const homes = new Map<string, { name: string; children: string[] }>();
				for (const r of rows) {
					const key = String(r.fields.householdId ?? `none:${r.id}`);
					const home = homes.get(key) ?? { name: String(r.fields.household ?? "No household"), children: [] };
					home.children.push(r.label);
					homes.set(key, home);
				}
				const counts = " People with no adult or child recorded aren't counted.";
				if (!homes.size) return `No household in this church has a child recorded.${counts}`;
				const listed = [...homes.values()].map((h) => `${h.name} (${and(h.children)})`);
				return `${counted(homes.size, "household")} ${countWord(homes.size, "has", "have")} a child recorded: ${and(listed)}.${counts}`;
			},
		};
	const moved = MOVED.exec(text);
	const stage = STAGES.find((s) => s === moved?.[1]?.toLowerCase().trim().replace(/\s+/g, "_"));
	if (moved && stage) {
		const today = localToday();
		const label = stage.replace(/_/g, " ");
		return {
			input: { movedInto: { stage, from: `${today.slice(0, 8)}01`, through: today } },
			names: true,
			answer: (out, rows) => {
				const total = Number(out.total);
				const moves = rows.map((r) => `${r.label} on ${dayText(String(r.fields.movedOn), { year: "never" })}`);
				return total
					? `${counted(total, "person", "people")} moved into ${label} this month: ${and(moves)}.`
					: `No one moved into ${label} this month.`;
			},
		};
	}
	return null;
}

function matchedSkills(row: Row, wanted: Set<string>) {
	return String(row.fields.skills ?? "")
		.split("; ")
		.flatMap((s) => {
			const m = /^(.+) \((\w+)\), (.+)$/.exec(s);
			return m && wanted.has(m[2]!) ? [`${m[1]}, ${m[3]}`] : [];
		})
		.join("; ");
}

function nextPage(out: Output, rows: Row[], named: boolean) {
	const more = out.next !== null && out.next !== undefined;
	const listed = named
		? ""
		: ` ${out.page === 1 && more ? "These are the first" : "These are"} ${rows.length}: ${and(rows.map((r) => r.label))}.`;
	const pages = out.facts?.pages ? ` of ${String(out.facts.pages)}` : "";
	return more ? `${listed} Want the next page (page ${String(out.next)}${pages})?` : listed;
}

export function peopleStep(options: LanguageModelV4CallOptions, text: string): Content | null {
	const ask = asked(text);
	const { offers, of } = turnOf(options);
	if (!ask || !offers("people.listPeople")) return null;
	const out = of("people.listPeople");
	if (!out) return call("people_read", { operation: "people.listPeople", input: ask.input });
	if (out.error) return say(`I could not finish that read (${String(out.error)}).`);
	const rows = out.rows ?? [];
	const inChurch = Number(out.facts?.peopleInChurch);
	return say(ask.answer(out, rows, inChurch) + (rows.length ? nextPage(out, rows, !!ask.names) : ""));
}
