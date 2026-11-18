import * as c from "@everyfield/contracts/intelligence";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/gi;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const NUMBER = /(?<![\w.])\d+(?:\.\d+)?(?![\w])/g;

const WORDING: [c.DraftRule, RegExp][] = [
	[
		"private_content",
		/\b(check[- ]?ins?|private notes?|interview notes?|notes? (?:from|on|about)|scored?|scores|not qualified|disqualif\w*|qualified|struggl\w*|strained|marriage)\b/i,
	],
	[
		"judgment",
		/\b(healthy church|unhealthy|church(?:'s)? health|spiritual(?:ly)? (?:ready|mature|immature|unfit|fit)|spiritual (?:maturity|readiness|fitness)|godly|ungodly|faithful(?:ness)?|lazy|character|doctrin\w*|theolog\w*|heretic\w*|sinful)\b/i,
	],
	[
		"readiness_verdict",
		/\b(you(?:'re| are) ready|(?:is|are) ready (?:to|for) launch|ready to launch|launch[- ]ready|cleared to launch|should (?:now )?(?:launch|move (?:on )?to phase|advance))\b/i,
	],
	[
		"action_claim",
		/\b(?:(?:I|we|Everyfield)(?: have|'ve)? (?:created|added|sent|scheduled|assigned|moved|changed|updated)|(?:has|have) been (?:created|sent|scheduled|assigned|moved)|I(?:'ll| will) (?:create|send|schedule|move|assign))\b/i,
	],
];

const TOPIC: Record<c.FactTopic, RegExp> = {
	committedAdults: /committed[- ]adults?|adult count|core group size/i,
	growth: /\bgrowth\b|new adults?|momentum/i,
	vision: /vision (?:meeting|rhythm|gathering)s?/i,
	cohesion: /cohesion|disengag/i,
	followUps: /follow[- ]?ups?/i,
	training: /\btraining\b/i,
};
const KNOWN_CLAIM = [
	/(?<!at least )\b\d+\s+(?:committed[- ]adults?|new adults?|days?|follow[- ]?ups?|people)\b/i,
	/\b(?:at|below|above|under|over|reached|short of|fewer than|more than|less than|past|hit)\s+\d+/i,
	/\b(?:met|not met|on track|on target|stalled|slowed|steady|complete|completed|done)\b/i,
];

type Where = { where: string; text: string; citations: readonly string[] };
const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());

function datesOf(values: Iterable<c.FactEntry["value"]>) {
	const out = new Set<string>();
	for (const v of values) if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) out.add(v);
	return out;
}
function numbersOf(values: Iterable<c.FactEntry["value"]>) {
	const out = new Set<number>();
	for (const v of values) {
		if (typeof v === "number") out.add(v);
		if (Array.isArray(v)) for (const n of v) out.add(n);
	}
	return out;
}

export function checkDraft(raw: unknown, input: c.ModelInput): c.Violation[] {
	const parsed = c.draftOutput.safeParse(raw);
	if (!parsed.success)
		return [{ rule: "shape", where: "draft", detail: parsed.error.issues[0]?.path.join(".") || "draft" }];
	const draft = parsed.data;
	const facts = new Map(input.facts.map((f) => [f.key, f]));
	const passages = new Map(input.passages.map((p) => [p.key, p]));
	const points: Where[] = [
		{ where: "focus", text: `${draft.focus.title}. ${draft.focus.body}`, citations: draft.focus.citations },
		...draft.supporting.map((p, i) => ({
			where: `supporting.${i}`,
			text: `${p.title}. ${p.body}`,
			citations: p.citations,
		})),
		...draft.positives.map((p, i) => ({
			where: `positives.${i}`,
			text: `${p.title}. ${p.body}`,
			citations: p.citations,
		})),
	];
	const out: c.Violation[] = [];
	for (const p of points) {
		if (!p.citations.length) out.push({ rule: "missing_citation", where: p.where, detail: "no citation" });
		for (const key of p.citations)
			if (!facts.has(key) && !passages.has(key)) out.push({ rule: "invented_citation", where: p.where, detail: key });
	}
	const summary = { where: "summary", text: draft.summary, citations: points.flatMap((p) => p.citations) };
	for (const p of [...points, summary]) {
		const values = p.citations.flatMap((k) => (facts.has(k) ? [facts.get(k)!.value] : []));
		out.push(...numbersAndDates(p, values, input), ...wording(p), ...unknowns(p, facts));
	}
	return out;
}

function numbersAndDates(p: Where, values: c.FactEntry["value"][], input: c.ModelInput): c.Violation[] {
	const out: c.Violation[] = [];
	const dates = datesOf(values);
	const monthDays = new Set([...dates].map((d) => `${Number(d.slice(5, 7)) - 1}-${Number(d.slice(8, 10))}`));
	let text = p.text.replace(ISO_DATE, (m) => {
		if (!dates.has(m)) out.push({ rule: "invented_date", where: p.where, detail: m });
		return " ";
	});
	text = text.replace(MONTH_DATE, (m, month: string, day: string, year?: string) => {
		const index = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
		const iso = year && `${year}-${String(index + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
		if (!(iso ? dates.has(iso) : monthDays.has(`${index}-${Number(day)}`)))
			out.push({ rule: "invented_date", where: p.where, detail: m });
		return " ";
	});
	text = text.replace(new RegExp(`\\bphase\\s+${input.phase}\\b`, "gi"), " ");
	const allowed = numbersOf(values);
	for (const m of text.matchAll(NUMBER))
		if (!allowed.has(Number(m[0]))) out.push({ rule: "invented_number", where: p.where, detail: m[0] });
	return out;
}

function wording(p: Where): c.Violation[] {
	return WORDING.flatMap(([rule, pattern]) => {
		const m = pattern.exec(p.text);
		return m ? [{ rule, where: p.where, detail: m[0] }] : [];
	});
}

function unknowns(p: Where, facts: Map<string, c.FactEntry>): c.Violation[] {
	const out: c.Violation[] = [];
	for (const topic of c.FACT_TOPICS) {
		if (facts.get(`${topic}.status`)?.value !== "unknown") continue;
		for (const s of sentences(p.text)) {
			if (!TOPIC[topic].test(s)) continue;
			const claim = KNOWN_CLAIM.map((r) => r.exec(s)).find(Boolean);
			if (claim) out.push({ rule: "unknown_as_known", where: p.where, detail: `${topic}: ${claim[0]}` });
		}
	}
	return out;
}

export function draftText(draft: c.DraftOutput): string {
	const point = (label: string, p: c.DraftPoint) => `${label}: ${p.title}\n${p.body}\n[${p.citations.join(", ")}]`;
	return [
		`Summary: ${draft.summary}`,
		point("Main focus", draft.focus),
		...draft.supporting.map((p, i) => point(`Supporting ${i + 1}`, p)),
		...draft.positives.map((p, i) => point(`Going well ${i + 1}`, p)),
	].join("\n\n");
}
