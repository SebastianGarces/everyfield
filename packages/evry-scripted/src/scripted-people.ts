import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { counted, countWord, dayText } from "@everyfield/contracts/common";
import { call, say, turnOf, type Content, type Output, type Row } from "./scripted-turn.ts";

const TECH_SKILLS = /\b(tech|technical|sound|audio|video|av|lighting|slides)\b[^.?!]{0,20}\bskill(s|ed)?\b/i;
const NO_PHOTO = /\b(no|without|doesn['’]?t have|don['’]?t have|missing)\b[^.?!]{0,20}\b(photo|picture)s?\b/i;
const NO_HOUSEHOLD = /\b(isn['’]?t|aren['’]?t|not|no one)\b[^.?!]{0,10}\bin (any|a) household\b/i;
const CHILDREN = /\b(which|what|any) households?\b[^.?!]{0,30}\b(kids|children|child)\b/i;
const MOVED_CORE = /\bmoved? (?:in)?to (?:the )?core group this month\b/i;

const localToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
const and = (items: string[]) => new Intl.ListFormat("en-US", { type: "conjunction" }).format(items);

type Ask = {
	input: Record<string, unknown>;
	answer: (out: Output, rows: Row[], inChurch: number) => string;
	none: (inChurch: number) => string;
};

function asked(text: string): Ask | null {
	if (TECH_SKILLS.test(text))
		return {
			input: { skillCategories: ["tech"] },
			none: (inChurch) =>
				`No one in this church has a Tech skill recorded. That covers all ${inChurch} people in this church.`,
			answer: (out, rows, inChurch) => {
				const held = rows.map((r) => `${r.label} (${techSkills(r)})`);
				return `${String(out.total)} of the ${inChurch} people in this church have a Tech skill recorded: ${and(held)}. That covers all ${inChurch} people in this church.`;
			},
		};
	if (NO_PHOTO.test(text))
		return {
			input: { hasPhoto: false },
			none: (inChurch) => `All ${inChurch} people in this church have a photo.`,
			answer: (out, rows, inChurch) =>
				`${String(out.total)} of the ${inChurch} people in this church have no photo.${listed(out, rows)}`,
		};
	if (NO_HOUSEHOLD.test(text))
		return {
			input: { inHousehold: false },
			none: (inChurch) => `All ${inChurch} people in this church are in a household.`,
			answer: (out, rows, inChurch) =>
				`${String(out.total)} of the ${inChurch} people in this church are in no household.${listed(out, rows)}`,
		};
	if (CHILDREN.test(text))
		return {
			input: { adultClassification: "child" },
			none: () =>
				"No household in this church has a child recorded. People with no adult or child recorded aren't counted.",
			answer: (_, rows) => {
				const homes = new Map<string, { name: string; children: string[] }>();
				for (const r of rows) {
					const key = String(r.fields.householdId);
					const home = homes.get(key) ?? { name: String(r.fields.household), children: [] };
					home.children.push(r.label);
					homes.set(key, home);
				}
				const listed = [...homes.values()].map((h) => `${h.name} (${and(h.children)})`);
				return `${counted(homes.size, "household")} ${countWord(homes.size, "has", "have")} a child recorded: ${and(listed)}. People with no adult or child recorded aren't counted.`;
			},
		};
	if (MOVED_CORE.test(text)) {
		const today = localToday();
		return {
			input: { movedInto: { stage: "core_group", from: `${today.slice(0, 8)}01`, through: today } },
			none: () => "No people moved into core group this month.",
			answer: (out, rows) => {
				const moves = rows.map((r) => `${r.label} on ${dayText(String(r.fields.movedOn), { year: "never" })}`);
				return `${counted(Number(out.total), "person", "people")} moved into core group this month: ${and(moves)}.`;
			},
		};
	}
	return null;
}

function techSkills(row: Row) {
	return String(row.fields.skills ?? "")
		.split("; ")
		.flatMap((s) => {
			const m = /^(.+) \((\w+)\), (.+)$/.exec(s);
			return m?.[2] === "tech" ? [`${m[1]}, ${m[3]}`] : [];
		})
		.join("; ");
}

const more = (out: Output) => out.next !== null && out.next !== undefined;

function listed(out: Output, rows: Row[]) {
	const first = out.page === 1 && more(out) ? "the first " : "";
	return ` These are ${first}${rows.length}: ${and(rows.map((r) => r.label))}.`;
}

function offer(out: Output) {
	const pages = out.facts?.pages ? ` of ${String(out.facts.pages)}` : "";
	return more(out) ? ` Want the next page (page ${String(out.next)}${pages})?` : "";
}

export function peopleStep(options: LanguageModelV4CallOptions, text: string): Content | null {
	const ask = asked(text);
	const { offers, of } = turnOf(options);
	if (!ask || !offers("people.listPeople")) return null;
	const out = of("people.listPeople");
	if (!out) return call("people_read", { operation: "people.listPeople", input: ask.input });
	const rows = out.rows ?? [];
	const inChurch = Number(out.facts?.peopleInChurch);
	if (!rows.length) return say(ask.none(inChurch));
	return say(ask.answer(out, rows, inChurch) + offer(out));
}
