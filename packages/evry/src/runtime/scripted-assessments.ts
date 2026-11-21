import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { captured, present } from "./captured.ts";

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { kind: string; id: string; label: string; fields: Record<string, unknown> };
type Output = Record<string, unknown> & { operation?: string; rows?: Row[]; proposalId?: string; refusal?: string };
type Call = (toolName: string, input: unknown) => LanguageModelV4Content;
const say = (text: string): LanguageModelV4Content[] => [{ type: "text", text }];

function turnOutputs(prompt: Prompt): Output[] {
	const out: Output[] = [];
	for (let i = prompt.length - 1; i >= 0; i--) {
		const m = present(prompt[i]);
		if (m.role === "user") break;
		if (m.role !== "tool") continue;
		for (const part of [...m.content].reverse())
			if (part.type === "tool-result" && part.output.type === "json") out.unshift(part.output.value as Output);
	}
	return out;
}
const userTexts = (prompt: Prompt) =>
	prompt.flatMap((m) => (m.role === "user" ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])) : []));
const assistantTexts = (prompt: Prompt) =>
	prompt.flatMap((m) => (m.role === "assistant" ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])) : []));

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function today(prompt: Prompt) {
	const system = prompt.find((m) => m.role === "system");
	const at = system ? /Current time \(trusted server clock\): (\S+?)\.?$/m.exec(system.content)?.[1] : undefined;
	const now = at ? new Date(at) : new Date();
	return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
}
const shift = (day: string, days: number) =>
	new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
function dateIn(text: string, prompt: Prompt): string | null {
	const day = today(prompt);
	if (/\btoday\b/i.test(text)) return day;
	if (/\byesterday\b/i.test(text)) return shift(day, -1);
	const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:,? (\d{4}))?\b/i.exec(text);
	if (!m) return null;
	const month = String(MONTHS.indexOf(captured(m, 1).toLowerCase()) + 1).padStart(2, "0");
	return `${m[3] ?? day.slice(0, 4)}-${month}-${captured(m, 2).padStart(2, "0")}`;
}
const longDate = (day: unknown) =>
	typeof day === "string"
		? new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
				timeZone: "UTC",
			})
		: "an unknown date";

const CRITERIA = [
	["maturity", /\bmaturity\b/],
	["gifted", /\bgifted\b/],
	["chemistry", /\bchemistry\b/],
	["rightReasons", /\bright reasons\b/],
	["season", /\bseason\b/],
] as const;
const CRITERION_WORDS: Record<string, string> = {
	maturity: "spiritual maturity",
	gifted: "gifted",
	chemistry: "chemistry",
	rightReasons: "right reasons",
	season: "season",
};
const RESULTS = [
	["qualified_with_notes", /\bqualified with notes\b/],
	["not_qualified", /\bnot qualified\b/],
	["follow_up", /\bfollow[ -]up\b/],
	["qualified", /\bqualified\b/],
] as const;
const LENSES = ["committed", "compelled", "contagious", "courageous"] as const;
const RESULT_WORDS: Record<string, string> = {
	qualified: "qualified",
	qualified_with_notes: "qualified with notes",
	not_qualified: "not qualified",
	follow_up: "follow up",
};

function named(text: string) {
	return (
		/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?)['’]s\b/.exec(text)?.[1] ??
		/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?) signed\b/.exec(text)?.[1] ??
		null
	);
}

type Intent =
	| { kind: "interviews" | "assessments" | "commitments" | "corrections"; name: string }
	| {
			kind: "record_interview";
			name: string;
			occurredOn: string | null;
			ratings: Record<string, string>;
			result: string | null;
	  }
	| { kind: "record_assessment"; name: string; occurredOn: string | null; scores: Record<string, number> }
	| { kind: "record_commitment"; name: string; occurredOn: string | null; commitment: "core_group" | "launch_team" }
	| { kind: "lifecycle"; name: string; to: "withdrawn" | "active"; on: string | null }
	| { kind: "fix_interview_date"; name: string; occurredOn: string | null }
	| { kind: "fix_card_date"; name: string; occurredOn: string | null; reason: string }
	| { kind: "destination"; personId: string }
	| { kind: "merge"; names: string[] }
	| { kind: "unmerge" };

function intentOf(text: string, prompt: Prompt): Intent | null {
	const lower = text.toLowerCase();
	if (/\bundo (that|the) merge\b|\bunmerge\b/.test(lower)) return { kind: "unmerge" };
	const record = /\bwhere does (?:the )?record ([0-9a-f-]{36}) lead\b/i.exec(text);
	if (record) return { kind: "destination", personId: captured(record, 1) };
	const merge = /\bmerge (them|([a-z][\w' ]+?) (?:and|with|into) ([a-z][\w' ]+?))\s*[.?!]?$/i.exec(text);
	if (merge)
		return { kind: "merge", names: merge[2] ? [merge[2], captured(merge, 3)] : userTexts(prompt).flatMap(nameList) };
	const name = named(text);
	if (!name) return null;
	if (/\bfix\b.*\binterview date\b/.test(lower))
		return { kind: "fix_interview_date", name, occurredOn: dateIn(text.split(/\binterview date\b/i)[1] ?? "", prompt) };
	if (/\bcorrection/.test(lower)) return { kind: "corrections", name };
	const card = /\bcard was signed (.+?), not\b/i.exec(text);
	if (card) return { kind: "fix_card_date", name, occurredOn: dateIn(captured(card, 1), prompt), reason: text.trim() };
	if (/\brecord\b.*\binterview\b/.test(lower)) {
		const ratings: Record<string, string> = {};
		for (const [k, re] of CRITERIA) {
			const m = new RegExp(`${re.source}\\s+(pass|concern|fail)`).exec(lower);
			if (m) ratings[k] = captured(m, 1);
		}
		const result = RESULTS.find(([, re]) => re.test(lower))?.[0] ?? null;
		return { kind: "record_interview", name, occurredOn: dateIn(text, prompt), ratings, result };
	}
	if (/\b(four|4) c['’]?s\b/.test(lower) && /\brecord\b/.test(lower)) {
		const scores: Record<string, number> = {};
		for (const k of LENSES) {
			const m = new RegExp(`\\b${k}\\s+([1-5])\\b`).exec(lower);
			if (m) scores[k] = Number(m[1]);
		}
		return { kind: "record_assessment", name, occurredOn: dateIn(text, prompt), scores };
	}
	const signed = /\bsigned the (core group|launch team) commitment\b/.exec(lower);
	if (signed)
		return {
			kind: "record_commitment",
			name,
			occurredOn: dateIn(text, prompt),
			commitment: signed[1] === "core group" ? "core_group" : "launch_team",
		};
	const life = /\b(withdraw|reactivate)\b.*\bcommitment\b/.exec(lower);
	if (life)
		return { kind: "lifecycle", name, to: life[1] === "withdraw" ? "withdrawn" : "active", on: dateIn(text, prompt) };
	if (/\binterview/.test(lower)) return { kind: "interviews", name };
	if (/\b(four|4) c['’]?s\b|\bassessment/.test(lower)) return { kind: "assessments", name };
	if (/\bcommitment\b/.test(lower)) return { kind: "commitments", name };
	return null;
}
function nameList(text: string) {
	const m = /\b([a-z]+ [a-z]+) (?:the same as|and|or) ([a-z]+ [a-z]+)\b/i.exec(text.replace(/^is /i, ""));
	return m ? [captured(m, 1), captured(m, 2)] : [];
}
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function missing(intent: Intent): string | null {
	if (intent.kind === "record_interview") {
		const left = CRITERIA.filter(([k]) => !intent.ratings[k]).map(([k]) => present(CRITERION_WORDS[k]));
		const parts = [
			...left.map((k) => `the ${k} rating`),
			...(intent.result ? [] : ["the result"]),
			...(intent.occurredOn ? [] : ["the interview date"]),
		];
		return parts.length ? parts.join(", ") : null;
	}
	if (intent.kind === "record_assessment") {
		const parts = [
			...LENSES.filter((k) => !intent.scores[k]).map((k) => `the ${k} score`),
			...(intent.occurredOn ? [] : ["the date"]),
		];
		return parts.length ? parts.join(", ") : null;
	}
	if (intent.kind === "record_commitment" && !intent.occurredOn) return "the date it was signed";
	if (intent.kind === "lifecycle" && !intent.on) return "the date it takes effect";
	if ((intent.kind === "fix_interview_date" || intent.kind === "fix_card_date") && !intent.occurredOn)
		return "the correct date";
	return null;
}

function interviewText(person: string, r: Row) {
	const f = r.fields;
	const criteria = CRITERIA.map(([k]) => {
		const notes = typeof f[`${k}Notes`] === "string" ? ` (${String(f[`${k}Notes`])})` : "";
		return `${CRITERION_WORDS[k]} ${String(f[k])}${notes}`;
	}).join(", ");
	const next = typeof f.nextSteps === "string" ? ` Next steps: ${f.nextSteps}` : "";
	return `${person}'s interview on ${longDate(f.occurredOn)}: ${criteria}. Result: ${RESULT_WORDS[String(f.result)] ?? String(f.result)}.${next}`;
}

export function assessmentStep(
	text: string,
	prompt: Prompt,
	records: boolean,
	toolCall: Call,
): LanguageModelV4Content[] | null {
	const intent = intentOf(text, prompt);
	if (!intent) return null;
	if (!records)
		return say(
			"Interviews, 4 C's assessments and commitments are for the church's Owners and Admins, so I can't show or change them for you.",
		);
	const gap = missing(intent);
	if (gap) return say(`I need ${gap} before I prepare this. I won't fill it in for you.`);
	const outputs = turnOutputs(prompt);
	const last = outputs.at(-1);
	const read = (operation: string, input: unknown) => [toolCall("peopleAssessments_read", { operation, input })];
	const propose = (operation: string, input: unknown) => [toolCall("propose_change", { operation, input })];
	const of = (operation: string) => outputs.findLast((o) => o.operation === operation);

	if (last && typeof last.proposalId === "string") {
		if (last.refusal) return say(String(last.refusal));
		const target = last.rows?.[0]?.label ?? "this person";
		if (intent.kind === "merge" || intent.kind === "unmerge")
			return say(
				intent.kind === "merge"
					? `I prepared a merge review: ${String(of("people.getMergeReview")?.rows?.[1]?.label ?? "the duplicate")} merges into ${target}. Nothing changes until you approve it.`
					: `I prepared an Unmerge review for ${target}. Nothing changes until you approve it.`,
			);
		return say(`I prepared a review for ${target}. Nothing is recorded until you approve it.`);
	}
	if (last?.error) return say(`I could not finish that (${String(last.error)}).`);

	if (intent.kind === "merge") {
		const pairs = of("people.listDuplicatePairs");
		if (!pairs) return [toolCall("people_read", { operation: "people.listDuplicatePairs", input: {} })];
		const review = of("people.getMergeReview");
		if (!review) {
			const rows = pairs.rows ?? [];
			const pair =
				rows.find((r) => intent.names.some((n) => same(n, r.label) || same(n, String(r.fields.mayDuplicate ?? "")))) ??
				(intent.names.length ? undefined : rows[0]);
			if (!pair) return say("I can't find those two people among the possible duplicates to review.");
			return read("people.getMergeReview", { sourceId: pair.id, survivorId: pair.fields.mayDuplicateId });
		}
		const merge = review.rows?.find((r) => r.kind === "merge");
		if (!merge) return say("I can't review that merge: one of them is no longer available.");
		if (typeof merge.fields.blocked === "string") return say(`${merge.fields.blocked} Nothing was merged.`);
		const [survivor, source] = present(review.rows);
		return propose("people.mergePeople", { sourceId: present(source).id, survivorId: present(survivor).id });
	}

	if (intent.kind === "destination") {
		const got = of("people.mergedPersonDestination");
		if (!got) return read("people.mergedPersonDestination", { personId: intent.personId });
		const row = got.rows?.[0];
		if (!row) return say("I can't find that record in this church.");
		return say(
			row.fields.status === "merged"
				? `That record was merged into another person (${String(row.fields.destinationId)}).`
				: `That record is ${String(row.fields.status)}; it leads to itself.`,
		);
	}

	if (intent.kind === "unmerge") {
		const preview = of("people.previewUnmerge");
		if (!preview) {
			const into = assistantTexts(prompt)
				.map((t) => /\binto ([A-Z][\w'-]+(?: [A-Z][\w'-]+)?)/.exec(t)?.[1])
				.filter((n): n is string => Boolean(n));
			const candidates = [...into.reverse(), ...userTexts(prompt).flatMap(nameList)];
			const searched = outputs.filter((o) => o.operation === "people.listPeople");
			const person = searched.flatMap((o) => o.rows ?? [])[0];
			if (!person) {
				const next = candidates[searched.length];
				if (!next) return say("Which merge do you mean? Tell me who stayed.");
				return [toolCall("people_read", { operation: "people.listPeople", input: { search: next } })];
			}
			return read("people.previewUnmerge", { personId: person.id });
		}
		const row = preview.rows?.[0];
		if (!row) return say("There is no merge to undo for that person.");
		if (typeof row.fields.blocked === "string") return say(`${row.fields.blocked} Nothing was changed.`);
		return propose("people.unmergePeople", { mergeId: row.id });
	}

	const found = of("people.listPeople");
	if (!found) return [toolCall("people_read", { operation: "people.listPeople", input: { search: intent.name } })];
	const rows = found.rows ?? [];
	const exact = rows.filter((r) => same(r.label, intent.name));
	const word = rows.filter((r) => r.label.toLowerCase().startsWith(`${intent.name.toLowerCase()} `));
	const matches = exact.length === 1 ? exact : word.length ? word : rows;
	if (!matches.length) return say(`I can't find ${intent.name} in this church.`);
	if (matches.length > 1)
		return say(`I found ${matches.length} matches: ${matches.map((r) => r.label).join(", ")}. Which one do you mean?`);
	const person = present(matches[0]);
	const personId = person.id;

	switch (intent.kind) {
		case "interviews": {
			const got = of("people.getInterviews");
			if (!got) return read("people.getInterviews", { personId });
			const [latest] = got.rows ?? [];
			return say(latest ? interviewText(person.label, latest) : `There is no recorded interview for ${person.label}.`);
		}
		case "assessments": {
			const got = of("people.getAssessments");
			if (!got) return read("people.getAssessments", { personId });
			const [a] = got.rows ?? [];
			if (!a) return say(`There is no recorded 4 C's assessment for ${person.label}.`);
			const scores = LENSES.map((k) => `${k} ${String(a.fields[k])}`).join(", ");
			return say(
				`${person.label}'s 4 C's on ${longDate(a.fields.occurredOn)}: ${scores}. Total ${String(a.fields.total)}.`,
			);
		}
		case "commitments": {
			const got = of("people.getCommitments");
			if (!got) return read("people.getCommitments", { personId });
			const [current, ...cards] = got.rows ?? [];
			const card = cards.find((c) => c.fields.voided !== true);
			if (!current || !card) return say(`${person.label} has no commitment recorded.`);
			const download = of("people.getCommitmentDownload");
			if (card.fields.document === "attached" && !download)
				return read("people.getCommitmentDownload", { commitmentId: card.id });
			const state = String(current.fields.state);
			const since = current.fields.effectiveOn ? ` since ${longDate(current.fields.effectiveOn)}` : "";
			const link = download?.rows?.[0]?.fields.href;
			return say(
				`${person.label}'s commitment is ${state}${since}. Latest card: ${card.label.replace(/ signed (\S+)$/, (_, d) => ` signed ${longDate(d)}`)}.${
					typeof link === "string" ? ` [Download the signed document](${link})` : ""
				}`,
			);
		}
		case "corrections": {
			const got = of("people.listRecordCorrections");
			if (!got) return read("people.listRecordCorrections", { personId });
			const items = got.rows ?? [];
			if (!items.length) return say(`No record of ${person.label} was corrected.`);
			const changed = (c: Row) =>
				(JSON.parse(String(c.fields.changes)) as { field: string; old: unknown; new: unknown }[])
					.map((x) => `${x.field} from ${JSON.stringify(x.old)} to ${JSON.stringify(x.new)}`)
					.join(", ");
			return say(items.map((c) => `${c.label}: ${changed(c)}`).join("\n"));
		}
		case "record_interview":
			return propose("people.createInterview", {
				personId,
				occurredOn: intent.occurredOn,
				...Object.fromEntries(Object.entries(intent.ratings).map(([k, rating]) => [k, { rating }])),
				result: intent.result,
			});
		case "record_assessment":
			return propose("people.createAssessment", {
				personId,
				occurredOn: intent.occurredOn,
				...Object.fromEntries(Object.entries(intent.scores).map(([k, score]) => [k, { score }])),
			});
		case "record_commitment":
			return propose("people.createCommitment", { personId, kind: intent.commitment, occurredOn: intent.occurredOn });
		case "lifecycle":
			return propose(intent.to === "withdrawn" ? "people.withdrawCommitment" : "people.reactivateCommitment", {
				personId,
				effectiveOn: intent.on,
			});
		case "fix_card_date": {
			const got = of("people.getCommitments");
			if (!got) return read("people.getCommitments", { personId });
			const card = got.rows?.find((r) => r.fields.record === "commitment" && r.fields.voided !== true);
			if (!card) return say(`${person.label} has no commitment card to correct.`);
			return propose("people.correctCommitmentLifecycle", {
				commitmentId: card.id,
				correction: { action: "correct", occurredOn: intent.occurredOn },
				reason: intent.reason,
			});
		}
		case "fix_interview_date": {
			const got = of("people.getInterviews");
			if (!got) return read("people.getInterviews", { personId });
			const [latest] = got.rows ?? [];
			if (!latest) return say(`There is no recorded interview for ${person.label} to fix.`);
			return propose("people.correctPersonRecord", {
				recordType: "interview",
				recordId: latest.id,
				changes: { occurredOn: intent.occurredOn },
			});
		}
	}
}
