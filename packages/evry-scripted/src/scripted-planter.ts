import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { captured, LAUNCH_RULES } from "@everyfield/evry";

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { kind?: string; id: string; label: string; fields: Record<string, unknown> };
type Output = Record<string, unknown> & {
	operation?: string;
	rows?: Row[];
	facts?: Record<string, unknown>;
	results?: Output[];
};

const call = (toolName: string, input: unknown): LanguageModelV4Content[] => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify(input) },
];
const say = (text: string): LanguageModelV4Content[] => [{ type: "text", text }];
const propose = (operation: string, input: unknown) => call("propose_change", { operation, input });

function turnOutputs(prompt: Prompt): Output[] {
	const start = prompt.findLastIndex((m) => m.role === "user");
	return prompt
		.slice(start + 1)
		.flatMap((m) =>
			m.role === "tool"
				? m.content.flatMap((p) =>
						p.type === "tool-result" && p.output.type === "json" ? [p.output.value as Output] : [],
					)
				: [],
		);
}

const NAME = "([A-Z][\\w'’-]*(?:\\s+[A-Z][\\w'’-]*)*)";
const RESTORE = new RegExp(`\\b(?:bring|get)\\s+${NAME}\\s+back\\b|\\b[Rr]estore\\s+${NAME}`);
const CLASSIFY = new RegExp(
	`\\b(record|correct)\\s+(?:that\\s+)?${NAME}(?:\\s+is|\\s+to|:)\\s+(?:an?\\s+)?(adult|child)(?:,?\\s+(?:since|as of)\\s+(\\d{4}-\\d{2}-\\d{2}))?(?:,?\\s+because\\s+(.+?))?[.!]?$`,
	"i",
);
const STAGES: Record<string, string> = {
	prospect: "prospect",
	attendee: "attendee",
	"following up": "following_up",
	interviewed: "interviewed",
	"core group": "core_group",
	"launch team": "launch_team",
	leader: "leader",
};
const STAGE = `(${Object.keys(STAGES).join("|")})`;
const MOVE = new RegExp(
	`\\bmove\\s+${NAME}\\s+(?:up\\s+)?to\\s+(?:the\\s+)?${STAGE}\\s+stage\\s+because\\s+(.+?)[.!]?$`,
);
const BEFORE_MOVE = new RegExp(`\\bbefore\\s+(?:I\\s+)?mov(?:e|ing)\\s+${NAME}\\s+to\\s+(?:the\\s+)?${STAGE}\\b`);
const TOP = new RegExp(`\\bput\\s+${NAME}\\s+at\\s+the\\s+top\\b`, "i");
const DRAFT = /\bwhat\s+does\s+(?:my|the|our)\s+(.+?)\s+draft\s+say\b/i;
const DEBRIEF = /\bsave\b.*\bdebrief\b.*\bso far\b[^:]*:\s*([\s\S]+)$/i;
const SUMMARY = /\bsave\b.*\bsummary\b.*\bso far\b[^:]*:\s*([\s\S]+)$/i;
const GUEST_COUNT = /\bguest count\b.*\b(?:wrong|off|fix)\b|\bfix\b.*\bguest count\b/i;
const NOT_GUEST = new RegExp(`\\b${NAME}\\s+(?:wasn['’]t|was not)\\s+a\\s+launch(?:\\s+sunday)?\\s+guest\\b`);
const REALLY = new RegExp(`\\blaunch(?:\\s+[Ss]unday)?\\s+guest\\s+${NAME}\\s+was\\s+really\\s+${NAME}`);
const KEEP_NOTES = /\bkeep\s+(?:your\s+)?(?:planning\s+)?notes\b[^:]*:\s*([\s\S]+)$/i;
const READ_NOTES = /\bwhat\b.*\b(?:your|planning)\s+notes\b/i;
const HAPPENED = /\bwhat\s+happened\s+(?:to|with)\b.*\b(?:change|changes|card|cards|proposed)\b/i;
const TOGETHER = /\bhow many people\b.*\bmeetings?\b.*\blaunch\b/i;
const AREAS: Record<string, RegExp> = {
	wentWell: /\bwhat went well\s*[:-]\s*([^;]+)/i,
	toChange: /\bwhat to change\s*[:-]\s*([^;]+)/i,
	operations: /\boperations\s*[:-]\s*([^;]+)/i,
	followUpPlan: /\bfollow-?up plan\s*[:-]\s*([^;]+)/i,
	supportNeeded: /\bsupport needed\s*[:-]\s*([^;]+)/i,
};

const ownerOnly = "Only an Owner or Admin of this church can make that change, so I prepared nothing.";
const prepared = (out: Output, what: string) =>
	out.status === "refused"
		? String(out.refusal)
		: `I prepared a review card to ${what}. Nothing changes until you approve it.`;

export function planterStep(options: LanguageModelV4CallOptions, text: string): LanguageModelV4Content[] | null {
	const tools = JSON.stringify(options.tools ?? []);
	const offers = (operation: string) => tools.includes(`"${operation}"`);
	const has = (name: string) => options.tools?.some((t) => t.name === name) ?? false;
	const outputs = turnOutputs(options.prompt);
	const last = outputs.at(-1);
	const read = (domain: string, operation: string, input: unknown) => call(`${domain}_read`, { operation, input });
	const found = (operation: string) => outputs.findLast((o) => o.operation === operation);
	const failed = () =>
		last?.error
			? say(typeof last.problem === "string" ? last.problem : `I couldn't do that (${String(last.error)}).`)
			: null;

	const person = (name: string): { row: Row } | { reply: LanguageModelV4Content[] } => {
		const listed = found("people.listPeople");
		if (!listed) return { reply: read("people", "people.listPeople", { search: name }) };
		const rows = listed.rows ?? [];
		const [row] = rows;
		if (row && rows.length === 1) return { row };
		return {
			reply: say(
				row
					? `${rows.length} people match ${name}: ${rows.map((r) => r.label).join(", ")}. Which one do you mean?`
					: `I can't find ${name} in this church.`,
			),
		};
	};
	const onPerson = (
		operation: string,
		name: string,
		input: (row: Row) => Record<string, unknown>,
		what: (row: Row) => string,
	) => {
		if (!offers(operation)) return say(ownerOnly);
		const who = person(name);
		if ("reply" in who) return failed() ?? who.reply;
		if (last && typeof last.proposalId === "string") return say(prepared(last, what(who.row)));
		return failed() ?? propose(operation, input(who.row));
	};

	const restore = RESTORE.exec(text);
	if (restore) {
		const name = restore[1] ?? captured(restore, 2);
		if (!offers("people.restorePerson")) return say(ownerOnly);
		if (last && typeof last.proposalId === "string")
			return say(prepared(last, `bring ${last.rows?.[0]?.label ?? name} back to People`));
		return failed() ?? propose("people.restorePerson", { name });
	}
	const classify = CLASSIFY.exec(text);
	if (classify) {
		const operation = /^record$/i.test(captured(classify, 1))
			? "people.recordAdultClassification"
			: "people.correctAdultClassification";
		const name = captured(classify, 2);
		const classification = captured(classify, 3).toLowerCase();
		const occurredOn = classify[4];
		const reason = classify[5];
		if (!occurredOn || !reason)
			return say("What date did you learn this, and how do you know? I prepared nothing yet.");
		return onPerson(
			operation,
			name,
			(row) => ({ personId: row.id, classification, occurredOn, reason }),
			(row) => `record ${row.label} as ${classification === "adult" ? "an adult" : "a child"}`,
		);
	}
	const before = BEFORE_MOVE.exec(text);
	if (before) {
		const stage = STAGES[captured(before, 2).toLowerCase()];
		const who = person(captured(before, 1));
		if ("reply" in who) return failed() ?? who.reply;
		const warnings = found("people.getStatusWarnings");
		if (!warnings) return failed() ?? read("people", "people.getStatusWarnings", { personId: who.row.id, stage });
		return say(
			`Before ${who.row.label} moves to ${captured(before, 2)}, the records show:\n${String(warnings.rows?.[0]?.fields.reminders)}`,
		);
	}
	const move = MOVE.exec(text);
	if (move)
		return onPerson(
			"people.changeStatus",
			captured(move, 1),
			(row) => ({ personId: row.id, stage: STAGES[captured(move, 2).toLowerCase()], reason: captured(move, 3) }),
			(row) => `move ${row.label} to ${captured(move, 2)}`,
		);
	const top = TOP.exec(text);
	if (top)
		return onPerson(
			"people.reorderPipeline",
			captured(top, 1),
			(row) => ({ personId: row.id, afterId: null }),
			(row) => `put ${row.label} first in their column`,
		);

	const draft = DRAFT.exec(text);
	if (draft && offers("communication.getDraft")) {
		const list = found("communication.list");
		if (!list) return read("communication", "communication.list", { subject: captured(draft, 1), state: "draft" });
		const [message] = list.rows ?? [];
		if (!message) return say("I can't find that draft in Messages.");
		const parts = outputs.filter((o) => o.operation === "communication.getDraft");
		const next = parts.length ? parts.at(-1)?.next : 1;
		if (typeof next === "number")
			return failed() ?? read("communication", "communication.getDraft", { communicationId: message.id, page: next });
		const body = parts.map((p) => String(p.rows?.[0]?.fields.body ?? "")).join("");
		return say(`Subject: ${message.label}\n\n${body}`);
	}

	const debrief = DEBRIEF.exec(text);
	if (debrief) {
		if (!offers("launch.saveDebriefDraft")) return say(LAUNCH_RULES.ownerOnly);
		if (last && typeof last.proposalId === "string")
			return say(prepared(last, "save the debrief so far as a draft, submitting nothing"));
		const input = Object.fromEntries(
			Object.entries(AREAS).flatMap(([key, pattern]) => {
				const said = pattern.exec(captured(debrief, 1))?.[1]?.trim();
				return said ? [[key, said]] : [];
			}),
		);
		return failed() ?? propose("launch.saveDebriefDraft", input);
	}
	const summary = SUMMARY.exec(text);
	if (summary) {
		if (!offers("launch.saveDebriefSummaryDraft")) return say(LAUNCH_RULES.ownerOnly);
		if (last && typeof last.proposalId === "string")
			return say(prepared(last, "save the summary so far as a draft, publishing nothing"));
		return failed() ?? propose("launch.saveDebriefSummaryDraft", { body: captured(summary, 1).trim() });
	}
	const notGuest = NOT_GUEST.exec(text);
	const really = REALLY.exec(text);
	if (notGuest || really || GUEST_COUNT.test(text)) {
		if (!offers("launch.correctGuestAttendance")) return say(LAUNCH_RULES.ownerOnly);
		if (last && typeof last.proposalId === "string") return say(prepared(last, "correct the named guests"));
		const wrongName = notGuest?.[1] ?? really?.[1];
		const rightName = really?.[2];
		const reads = outputs.filter((o) => o.operation === "launch.readDebrief");
		const roster = reads.at(-1);
		if (!roster) return failed() ?? read("launch", "launch.readDebrief", rightName ? { guestName: rightName } : {});
		if (last?.error) return failed();
		if (!wrongName) return say(LAUNCH_RULES.whichCount);
		const rows = roster.rows ?? [];
		const wrong = rows.find((r) => r.fields.guest && r.label === wrongName);
		if (!wrong) return say(`${wrongName} isn't named as a Launch Sunday guest, so I prepared nothing.`);
		if (!rightName) return propose("launch.correctGuestAttendance", { personId: wrong.id, correctPersonId: null });
		const matches = rows.filter((r) => r.fields.match === rightName);
		const [right] = matches;
		if (!right || matches.length > 1)
			return say(`${matches.length} people match ${rightName}. Which one was the guest? I prepared nothing.`);
		return propose("launch.correctGuestAttendance", { personId: wrong.id, correctPersonId: right.id });
	}

	const keep = KEEP_NOTES.exec(text);
	if (keep && has("update_planning_notes")) {
		const notes = outputs.find((o) => "notes" in o);
		if (!notes) return call("read_planning_notes", {});
		const saved = outputs.find((o) => "revision" in o && !("notes" in o));
		if (last?.error) return failed();
		if (!saved)
			return call("update_planning_notes", {
				notes: [notes.notes, captured(keep, 1).trim()].filter(Boolean).join("\n"),
				expectedRevision: notes.revision,
			});
		return say("I saved that in my planning notes for this conversation. Nothing in your records changed.");
	}
	if (READ_NOTES.test(text) && has("read_planning_notes")) {
		if (!last) return call("read_planning_notes", {});
		return (
			failed() ?? say(last.notes ? `My planning notes say:\n${String(last.notes)}` : "I have no planning notes here.")
		);
	}
	if (HAPPENED.test(text) && has("read_review")) {
		if (!last) return call("read_review", {});
		const rows = last.rows ?? [];
		return (
			failed() ??
			say(
				rows.length
					? rows
							.map((r) => `- ${r.label || "A change"}: ${String(r.fields.status)} (${String(r.fields.outcome)})`)
							.join("\n")
					: "I proposed no change in this conversation that you can see now.",
			)
		);
	}
	if (TOGETHER.test(text) && has("compose_reads")) {
		if (!last)
			return call("compose_reads", {
				reads: [
					{ operation: "people.listPeople", input: { limit: 1 } },
					{ operation: "meetings.list", input: { window: "upcoming" } },
					{ operation: "launch.readCountdown", input: {} },
				],
			});
		const of = (operation: string) => last.results?.find((r) => r.operation === operation);
		return (
			failed() ??
			say(
				`${String(of("people.listPeople")?.total)} people in People, ${String(of("meetings.list")?.total)} upcoming meetings, and the launch is ${String(of("launch.readCountdown")?.facts?.status)}.`,
			)
		);
	}
	return null;
}
