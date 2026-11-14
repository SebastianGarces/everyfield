import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { GUEST_NAME_MAX } from "@everyfield/contracts/launch";
import { launchDay } from "../adapters/launch/reads/index.ts";
import { LAUNCH_RULES } from "../context/compile.ts";

// The scripted model's Launch requests (WP-075, WP-076), for local previews and tests only. It answers through the same
// tools a model gets: the countdown, milestones, history and Launch Sunday as the Launch plan reads them, and review
// cards for a date move, a postponement, Launch Sunday's numbers, the debrief and the summary, and for completing or
// reopening a milestone it finds by name on the Launch plan (T-382). Every number it says is
// one a launch read returned. A reply the tools never serve (a seat that may not change the plan, a launch-team goal
// nothing records) is the product's own sentence from the system prompt (compile.ts), quoted only when the prompt
// holds it, so the evals test the text the real model is given.

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { kind?: string; id: string; label: string; fields: Record<string, unknown> };
type Output = Record<string, unknown> & {
	operation?: string;
	status?: string;
	total?: number | null;
	rows?: Row[];
	facts?: Record<string, unknown>;
};

const call = (toolName: string, input: unknown): LanguageModelV4Content[] => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify(input) },
];
const say = (text: string): LanguageModelV4Content[] => [{ type: "text", text }];

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
const systemText = (prompt: Prompt) => prompt.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n");
/** Evry's last answer before the current user message: a guest question it asked (T-383). */
function lastAssistantText(prompt: Prompt) {
	const start = prompt.findLastIndex((m) => m.role === "user");
	for (let i = start - 1; i >= 0; i--) {
		const m = prompt[i]!;
		if (m.role === "assistant") return m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ");
	}
	return "";
}

const COUNTDOWN =
	/\b(?:how many|how long)\b.*\b(?:days?|weeks?)\b.*\blaunch\b|\bdays? (?:till|until|to|left)\b.*\blaunch\b|\blaunch countdown\b/i;
const MILESTONES = /\bmilestones?\b/i;
const BLOCKED = /\b(?:blocked|overdue|late|behind)\b/i;
const GOAL = /\blaunch[- ]team\b.*\bgoal\b|\bgoal\b.*\blaunch[- ]team\b/i;
const GUESTS = /\bguests?\b.*\blaunch sunday\b|\blaunch sunday\b.*\bguests?\b|\bcame to (?:the )?launch\b/i;
const CHANGED = /\bwhat(?:'s| has)? changed\b.*\blaunch\b|\blaunch\b.*\bchanged\b/i;
const MOVE =
	/\b(?:push|move|change|reschedule|set)\b(?: the| our)? launch(?: sunday| date)?\b.*?\bto ([a-z]+\.? \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?)(.*)$/i;
const POSTPONE = /\bpostpone\b.*\blaunch\b|\blaunch\b.*\bpostpone/i;
const RECORD = /\brecord\b.*\b(?:launch|attendance)\b/i;
const SUBMIT = /\bsubmit\b.*\bdebrief\b/i;
const PUBLISH = /\b(?:publish|share)\b.*\bsummary\b/i;
/** "mark the venue milestone complete", "complete the venue milestone": the milestone's name as the user said it. */
const COMPLETE =
	/^(?:please\s+)?(?:mark|check off|complete)\s+(?:the\s+|our\s+)?(.+?)(?:\s+milestone)?(?:\s+(?:as\s+)?(?:complete|completed|done))?\s*[.!?]?$/i;
const REOPEN = /^(?:please\s+)?(?:reopen|re-open|uncheck)\s+(?:the\s+|our\s+)?(.+?)(?:\s+milestone)?\s*[.!?]?$/i;
/** "add Sam Ortiz, Jo Kim and Lee Park as launch guests": the names as the user typed them (T-383). */
const GUEST_ADD =
	/^(?:please\s+)?(?:add|name)\s+(.*?)\s*\bas\s+(?:a\s+|our\s+)?(?:first[- ]time\s+)?launch(?:\s+sunday)?\s+guests?\s*[.!?]?$/i;
/** "add Maria Lopez as a new person", after Evry asked which match a guest is. */
const GUEST_NEW = /^(?:please\s+)?(?:add|name)\s+(.+?)\s+as\s+a\s+new\s+person\b/i;
/** "the first one", "pick 2": which of the People Evry listed for a guest name. */
const GUEST_PICK =
	/^(?:please\s+)?(?:(?:pick|choose|use|link|add|it's|its|it is)\s+)?(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|existing|[1-8])(?:\s+(?:one|person))?\s*[.!]?$/i;
const ORDINAL: Record<string, number> = {
	first: 0,
	existing: 0,
	second: 1,
	third: 2,
	fourth: 3,
	fifth: 4,
	sixth: 5,
	seventh: 6,
	eighth: 7,
};
/** The guest name Evry last listed People for: the question a pick answers. */
const ASKED_GUEST = /People already (?:has|have) [^*]*matching \*\*(.+?)\*\*:/g;
/** "correct launch attendance to 162, we miscounted the overflow room" (T-383). */
const CORRECT = /^(?:please\s+)?(?:correct|fix)\b.*\blaunch\b/i;
const NOT_RECORDED_GUESTS =
	"Launch Sunday isn't recorded on the Launch plan yet, so no guests can be named. Record it first. I prepared nothing.";
/** The two milestones a submitted debrief decides (LCH-004): named by the user as the Launch plan shows them. */
const DERIVED = /\bguest data\b|\bdebrief\b/i;
/** Words a user may call a milestone by that its title doesn't use. */
const ALIASES: Record<string, string> = {
	venue: "worship center",
	fasting: "prayer and fasting",
};

/** The milestone rows of a workspace read whose title has every word of `name`, as the user said it. */
function matching(out: Output, name: string) {
	const said = name.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
	const words = said
		.split(/\s+/)
		.flatMap((w) => (ALIASES[w] ?? w).split(" "))
		.filter((w) => w && !["the", "our", "a", "an", "launch", "milestone", "of", "and"].includes(w));
	const rows = (out.rows ?? []).filter((r) => r.kind === "milestone");
	if (!words.length) return [];
	return rows.filter((r) => {
		const title = r.label.toLowerCase().split(/[^a-z0-9]+/);
		return words.every((w) => title.some((t) => t.startsWith(w)));
	});
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "march 14" or "Mar 14, 2027" as a church-local date: the next such day on or after `today` when no year is given. */
function dateOn(words: string, today: string): string | null {
	const m = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/i.exec(words.trim());
	const month = m ? MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) : -1;
	if (!m || month < 0) return null;
	const day = Number(m[2]);
	const iso = (y: number) => `${y}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	if (m[3]) return iso(Number(m[3]));
	const year = Number(today.slice(0, 4));
	return iso(year) >= today ? iso(year) : iso(year + 1);
}
/** The user's reason as given: the words after the date or the request, without the joining comma or "because". */
const reasonOf = (rest: string) =>
	rest
		.trim()
		.replace(/^[,;:.–—-]+\s*/, "")
		.replace(/^because\s+/i, "")
		.replace(/[.!]\s*$/, "")
		.trim() || null;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Nov 8" or "Nov 8, 2026" as a church-local date: the latest such day on or before `today` when no year is given. */
function pastDateOn(words: string, today: string): string | null {
	const next = dateOn(words, today);
	if (!next || /\d{4}\s*$/.test(words.trim()) || next <= today) return next;
	return `${Number(next.slice(0, 4)) - 1}${next.slice(4)}`;
}
const COUNT = (field: string) =>
	new RegExp(`\\b${field}\\b(?:\\s+(?:to|was|were|is|as|should be))?\\s+(-?\\d[\\d,]*)`, "i");
const UNKNOWN = (field: string) =>
	new RegExp(
		`\\b(?:don['’]?t|do not|didn['’]?t|did not)\\b(?:\\s+\\w+)?\\s+know how many\\s+(?:launch\\s+)?${field}\\b|\\b${field}\\b(?:\\s+(?:to|as))?\\s+(?:not recorded|unknown)\\b`,
		"i",
	);
const DATE_HELD =
	/\b(?:date|held|happened|was on)\b(?:\s+(?:to|as|on|was))?\s+([a-z]+\.? \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?)/i;
/** What a correction names: each field the user gave, its new value, and their reason as given. */
function correctionOf(text: string, today: string) {
	const held = DATE_HELD.exec(text);
	const rest = held ? text.replace(held[1]!, "") : text;
	const count = (field: string) => {
		if (UNKNOWN(field).test(text)) return null;
		const n = COUNT(field).exec(rest)?.[1]?.replace(/,+$/, "");
		return n === undefined ? undefined : Number(n.replace(/,/g, ""));
	};
	const fields: { actualDate?: string | null; attendance?: number | null; decisions?: number | null } = {};
	if (held) fields.actualDate = pastDateOn(held[1]!, today);
	const attendance = count("attendance");
	if (attendance !== undefined) fields.attendance = attendance;
	const decisions = count("decisions");
	if (decisions !== undefined) fields.decisions = decisions;
	const reason = reasonOf(/(?:[,;:–—]|\bbecause\b)\s*(.+)$/i.exec(rest)?.[1] ?? "");
	return { fields, reason, unread: held ? held[1]! : null };
}
const countSaid = (n: unknown) => (n === null ? "Not recorded" : String(n));

/** The countdown as the Launch plan says it, from the read's own facts. */
function countdownText(f: Record<string, unknown>) {
	switch (f.countdown) {
		case "none":
			return "No launch date is set yet, so there's no countdown. An Owner or Admin sets Launch Sunday on [Launch](/launch).";
		case "postponed":
			return "The launch is postponed, so there's no countdown until a new Launch Sunday is set.";
		case "completed":
			return "Launch Sunday is already recorded on the Launch plan, so there's no countdown.";
		case "today":
			return `Launch Sunday is today, ${String(f.plannedDate)}.`;
		case "overdue":
			return `Launch Sunday was planned for ${String(f.plannedDate)}, ${plural(Number(f.daysOverdue), "day", "days")} ago, and it isn't recorded yet.`;
		default:
			return `${plural(Number(f.daysLeft), "day", "days")} until Launch Sunday, ${String(f.plannedDate)}, as the Launch plan counts it from today in ${String(f.timeZone)}.`;
	}
}

function milestonesText(out: Output) {
	const f = out.facts ?? {};
	const rows = out.rows ?? [];
	const milestones = rows.filter((r) => r.kind === "milestone");
	const tasks = (id: string) => rows.filter((r) => r.kind === "item" && r.fields.milestoneId === id);
	const taskText = (t: Row) =>
		`${t.label}${t.fields.dueDate ? ` (due ${String(t.fields.dueDate)}${t.fields.overdue ? ", overdue" : ""})` : ""}`;
	if (f.filter === "blocked") {
		if (!milestones.length) return "No open launch milestone has an overdue linked prep task.";
		const lines = milestones.map(
			(m) =>
				`- **${m.label}**: ${tasks(m.id)
					.filter((t) => t.fields.overdue)
					.map(taskText)
					.join("; ")}`,
		);
		return `${plural(milestones.length, "launch milestone has", "launch milestones have")} an overdue prep task linked to it on the Launch plan:\n${lines.join("\n")}\n\nOnly a milestone's own linked prep tasks count.`;
	}
	if (!milestones.length)
		return `All ${String(f.milestonesTotal)} launch milestones are marked complete on the Launch plan.`;
	const lines = milestones.map((m) => {
		const open = tasks(m.id);
		return `- **${m.label}**: ${String(m.fields.done)} of ${String(m.fields.total)} tasks done${open.length ? `. Open: ${open.map(taskText).join("; ")}` : ""}`;
	});
	return `${milestones.length} of ${String(f.milestonesTotal)} launch milestones are still open, as the Launch plan shows them:\n${lines.join("\n")}`;
}

function guestsText(out: Output) {
	const f = out.facts ?? {};
	if (f.recorded !== true)
		return "Launch Sunday isn't recorded on the Launch plan yet, so no first-time guests are named.";
	const guests = (out.rows ?? []).filter((r) => r.kind === "person");
	const named = Number(f.guestsNamed ?? 0);
	const head =
		f.namesVisible === false
			? `${plural(named, "first-time guest is", "first-time guests are")} named on the Launch plan for ${String(f.actualDate)}. Only an Owner or Admin sees their names.`
			: named
				? `${plural(named, "first-time guest is", "first-time guests are")} named on the Launch plan for ${String(f.actualDate)}: ${guests.map((g) => g.label).join(", ")}.`
				: `No first-time guests are named on the Launch plan for ${String(f.actualDate)} yet.`;
	const attendance = typeof f.attendance === "number" ? f.attendance : null;
	const notes = [
		attendance !== null && attendance > named
			? `The recorded attendance was ${attendance}, so not everyone who came is named.`
			: "",
		typeof f.guestsNotNamed === "number" && f.guestsNotNamed > 0
			? `The debrief says ${plural(f.guestsNotNamed, "guest wasn't", "guests weren't")} entered by name.`
			: "",
	].filter(Boolean);
	return [head, ...notes].join(" ");
}

function journalText(out: Output, system: string) {
	const rows = out.rows ?? [];
	const since = out.facts?.since;
	const quoted = system.includes(LAUNCH_RULES.historyOnly) ? ` ${LAUNCH_RULES.historyOnly}` : "";
	if (!rows.length)
		return `Launch history shows no changes since ${typeof since === "string" ? launchDay(since) : "then"}.${quoted}`;
	const lines = rows.map((r) => {
		const f = r.fields;
		const what =
			f.change === "date" ? `${r.label} from ${String(f.from ?? "no date")} to ${String(f.to ?? "no date")}` : r.label;
		return `- ${what}, by ${String(f.by)} on ${String(f.on)}${typeof f.reason === "string" ? ` (reason: "${f.reason}")` : ""}`;
	});
	return `Since ${typeof since === "string" ? launchDay(since) : "then"}, Launch history shows:\n${lines.join("\n")}\n\n${quoted.trim()}`.trim();
}

/** The day `days` before a church-local date. */
const before = (day: string, days: number) =>
	new Date(Date.parse(`${day}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** A summary drafted from what the Launch plan recorded, for the planter to review word for word. */
function summaryFrom(f: Record<string, unknown>) {
	const counts = [
		typeof f.attendance === "number" ? `${f.attendance} people attended` : null,
		typeof f.decisions === "number" ? `${f.decisions} made a decision` : null,
	].filter(Boolean);
	return `We launched on ${String(f.actualDate)}.${counts.length ? ` ${counts.join(", and ")}.` : ""} Thank you for praying for us and sending us.`;
}

/** One step of a Launch request, or null when it is none. */
export function launchStep(options: LanguageModelV4CallOptions, text: string): LanguageModelV4Content[] | null {
	const tools = JSON.stringify(options.tools ?? []);
	const offers = (operation: string) => tools.includes(`"${operation}"`);
	if (!offers("launch.readCountdown")) return null;
	const system = systemText(options.prompt);
	const rule = (reply: string) => (system.includes(reply) ? say(reply) : null);
	const outputs = turnOutputs(options.prompt);
	const last = outputs.at(-1);
	const read = (operation: string, input: Record<string, unknown> = {}) => call("launch_read", { operation, input });
	const found = (operation: string) => outputs.findLast((o) => o.operation === operation);
	const propose = (operation: string, input: unknown) => call("propose_change", { operation, input });
	const proposed = typeof last?.proposalId === "string";

	const move = MOVE.exec(text);
	const named = (MILESTONES.test(text) || DERIVED.test(text)) && !/\?\s*$/.test(text);
	const complete = named ? COMPLETE.exec(text.trim()) : null;
	const reopen = named ? REOPEN.exec(text.trim()) : null;
	const guest = GUEST_ADD.exec(text.trim());
	const fresh = guest ? null : GUEST_NEW.exec(text.trim());
	const asked_for = [...lastAssistantText(options.prompt).matchAll(ASKED_GUEST)].at(-1)?.[1] ?? null;
	const pick = guest || fresh || !asked_for ? null : GUEST_PICK.exec(text.trim());
	const asked = {
		countdown: COUNTDOWN.test(text),
		milestones: MILESTONES.test(text),
		goal: GOAL.test(text),
		guests: GUESTS.test(text),
		changed: CHANGED.test(text),
		move: Boolean(move),
		postpone: POSTPONE.test(text),
		record: RECORD.test(text) && /\d/.test(text),
		submit: SUBMIT.test(text),
		publish: PUBLISH.test(text),
		complete: Boolean(complete),
		reopen: Boolean(reopen),
		guest: Boolean(guest || fresh || pick),
		correct: CORRECT.test(text.trim()),
	};
	if (!Object.values(asked).some(Boolean)) return null;
	if (last?.error) return say(`I couldn't do that (${String(last.error)}).`);
	// A launch read that could not load the plan: never an answer that there is no launch.
	if (last?.facts?.loaded === false) return rule(LAUNCH_RULES.unloaded);
	const writes =
		asked.move || asked.postpone || asked.record || asked.submit || asked.publish || asked.guest || asked.correct;
	if (writes && !offers("launch.schedule")) return rule(LAUNCH_RULES.ownerOnly);
	if (guest || fresh || pick) {
		if (!offers("launch.addGuestAttendance")) return rule(LAUNCH_RULES.ownerOnly);
		return guestStep(outputs, guest, fresh, pick, asked_for);
	}
	if (asked.correct) {
		if (!offers("launch.correctOutcome")) return rule(LAUNCH_RULES.ownerOnly);
		return correctStep(outputs, text);
	}
	const toggle = complete ?? reopen;
	if (toggle) {
		const operation = complete ? "launch.completeMilestone" : "launch.reopenMilestone";
		if (!offers(operation)) return rule(LAUNCH_RULES.ownerOnly);
		const name = toggle[1]!.trim();
		if (DERIVED.test(name)) return rule(LAUNCH_RULES.derived);
		const workspace = found("launch.readWorkspace");
		if (!workspace) return read("launch.readWorkspace", { filter: "all" });
		const matches = matching(workspace, name);
		if (proposed) return say(milestoneProposed(Boolean(complete), matches[0]));
		if (!matches.length)
			return say(
				`No launch milestone on the Launch plan matches "${name}", so I prepared nothing. Ask me which launch milestones are left to see them by name.`,
			);
		if (matches.length > 1)
			return say(
				`More than one launch milestone matches "${name}":\n${matches.map((m) => `- **${m.label}**`).join("\n")}\n\nWhich one do you mean? I prepared nothing.`,
			);
		const m = matches[0]!;
		const done = m.fields.completed === true;
		const marked = done || m.fields.needsReview === true;
		if (complete && done) return say(`**${m.label}** is already complete on the Launch plan, so I prepared nothing.`);
		if (reopen && !marked)
			return say(`**${m.label}** isn't complete, so there's nothing to reopen. I prepared nothing.`);
		return propose(operation, { milestoneId: m.id });
	}
	if (proposed) return say(proposedText(asked, last!));

	const countdown = found("launch.readCountdown");
	if (asked.move) {
		if (!countdown) return read("launch.readCountdown");
		const date = dateOn(move![1]!, String(countdown.facts?.today));
		if (!date) return say(`I couldn't read "${move![1]}" as a date. Say it like "March 14".`);
		const reason = reasonOf(move![2] ?? "");
		if (!reason && countdown.facts?.countdown !== "none")
			return say("Why is Launch Sunday moving? The reason stays in the Launch history, so tell me in your own words.");
		return propose("launch.schedule", { date, reason });
	}
	if (asked.postpone) {
		const reason = reasonOf(/\b(?:because|since|due to|[,:;–—-])\s*(.+)$/i.exec(text)?.[1] ?? "");
		if (!reason)
			return say(
				"Why is the launch being postponed? The reason stays in the Launch history, so tell me in your own words.",
			);
		return propose("launch.postpone", { reason });
	}
	if (asked.record) {
		const attendance = /(\d[\d,]*)\s+(?:people|attended|in attendance|adults)/i.exec(text)?.[1];
		const unnamed = /(\d[\d,]*)\s+guests?\b[^,.;]*\b(?:didn'?t|did not|without|no|weren'?t)\b[^,.;]*\bnames?\b/i.exec(
			text,
		)?.[1];
		const decisions = /(\d[\d,]*)\s+decisions?\b/i.exec(text)?.[1];
		const n = (v: string | undefined) => (v === undefined ? undefined : Number(v.replace(/,/g, "")));
		return propose("launch.recordOutcome", {
			attendance: n(attendance) ?? null,
			...(decisions !== undefined && { decisions: n(decisions) }),
			...(unnamed !== undefined && { guestsNotNamed: n(unnamed) }),
		});
	}
	if (asked.submit) return propose("launch.submitDebrief", {});
	if (asked.publish) {
		const given = /\bsummary\b[^:]*:\s*([\s\S]+)$/i.exec(text)?.[1]?.trim();
		if (given) return propose("launch.publishDebriefSummary", { body: given });
		const debrief = found("launch.readDebrief");
		if (!debrief) return read("launch.readDebrief");
		if (debrief.facts?.recorded !== true)
			return say("Launch Sunday isn't recorded yet, so there's nothing to summarize.");
		return propose("launch.publishDebriefSummary", { body: summaryFrom(debrief.facts) });
	}
	if (asked.goal) {
		const people = outputs.findLast((o) => o.operation === "people.listPeople");
		if (!people) return call("people_read", { operation: "people.listPeople", input: { stages: ["launch_team"] } });
		const n = Number(people.total ?? 0);
		const goal = system.includes(LAUNCH_RULES.noGoal) ? ` ${LAUNCH_RULES.noGoal}` : "";
		return say(`${plural(n, "person is", "people are")} in Launch team.${goal}`);
	}
	if (asked.guests) {
		const debrief = found("launch.readDebrief");
		if (!debrief) return read("launch.readDebrief");
		return say(guestsText(debrief));
	}
	if (asked.changed) {
		if (!offers("launch.readJournal"))
			return say("Launch history is for Owners and Admins. Ask one of them, or open [Launch](/launch).");
		if (!countdown) return read("launch.readCountdown");
		const journal = found("launch.readJournal");
		if (!journal) return read("launch.readJournal", { since: before(String(countdown.facts?.today), 7) });
		return say(journalText(journal, system));
	}
	if (asked.milestones) {
		const workspace = found("launch.readWorkspace");
		if (!workspace) return read("launch.readWorkspace", { filter: BLOCKED.test(text) ? "blocked" : "open" });
		return say(milestonesText(workspace));
	}
	if (asked.countdown) {
		if (!countdown) return read("launch.readCountdown");
		return say(countdownText(countdown.facts ?? {}));
	}
	return null;
}

const strip = (name: string) =>
	name
		.trim()
		.replace(/^["“”']+|["“”']+$/g, "")
		.trim();
/**
 * Naming Launch Sunday guests (T-383): one launch.readDebrief per typed name with its People matches, then a card for
 * each name nothing matches. A name with matches gets no card: Evry lists them and asks, and only the user picks.
 */
function guestStep(
	outputs: Output[],
	guest: RegExpExecArray | null,
	fresh: RegExpExecArray | null,
	pick: RegExpExecArray | null,
	askedFor: string | null,
): LanguageModelV4Content[] {
	const wait = "Nothing changes until you approve it.";
	const read = (input: Record<string, unknown>) => call("launch_read", { operation: "launch.readDebrief", input });
	const propose = (input: unknown) => call("propose_change", { operation: "launch.addGuestAttendance", input });
	const reads = outputs.filter((o) => o.operation === "launch.readDebrief");
	const proposals = outputs.filter((o) => typeof o.proposalId === "string");
	if (reads[0]?.facts?.recorded === false) return say(NOT_RECORDED_GUESTS);
	const matchesOf = (name: string) =>
		(reads.find((o) => o.facts?.guestName === name)?.rows ?? []).filter((r) => r.fields.match === name);

	if (pick) {
		const name = askedFor!;
		const out = reads.find((o) => o.facts?.guestName === name);
		if (!out) return read({ guestName: name });
		const matches = matchesOf(name);
		const at = ORDINAL[pick[1]!.toLowerCase()] ?? Number(pick[1]) - 1;
		const m = matches[at];
		if (proposals.length)
			return say(
				`I prepared a review card to list **${m?.label ?? name}**, already in People, as a Launch Sunday guest. No new Person is added. ${wait}`,
			);
		if (!m)
			return say(
				`I found ${plural(matches.length, "Person", "People")} matching **${name}**, so I can't tell which one you mean. I prepared nothing.`,
			);
		if (m.fields.alreadyGuest === true)
			return say(`**${m.label}** is already named as a Launch Sunday guest, so I prepared nothing.`);
		return propose({ personId: m.id });
	}
	if (fresh) {
		const name = strip(fresh[1]!);
		if (!reads.length) return read({});
		if (proposals.length)
			return say(
				`I prepared a review card to add **${name}** to People as a new Person with only that name, listed as a Launch Sunday guest. ${wait}`,
			);
		return propose({ displayName: name });
	}

	const names = guest![1]!.split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map(strip);
	const valid = names.filter((n) => n && n.length <= GUEST_NAME_MAX);
	for (const name of valid) if (!reads.some((o) => o.facts?.guestName === name)) return read({ guestName: name });
	const carded = new Set(proposals.map((o) => o.rows?.[0]?.label));
	const next = valid.find((n) => !matchesOf(n).length && !carded.has(n));
	if (next) return propose({ displayName: next });
	const lines = names.map((name) => {
		if (!name) return "A guest needs a name. A first name is enough. I prepared nothing for it.";
		if (name.length > GUEST_NAME_MAX)
			return `Keep a guest's name to ${GUEST_NAME_MAX} characters or fewer. I prepared nothing for that name.`;
		const matches = matchesOf(name);
		if (!matches.length)
			return `I prepared a review card to add **${name}** to People as a new Person with only that name, listed as a Launch Sunday guest.`;
		const list = matches
			.map(
				(m, n) =>
					`${n + 1}. **${m.label}**${m.fields.detail ? ` · ${String(m.fields.detail)}` : ""}${m.fields.alreadyGuest === true ? " (already a Launch Sunday guest)" : ""}`,
			)
			.join("\n");
		return `People already ${matches.length === 1 ? "has a Person" : `has ${matches.length} People`} matching **${name}**:\n${list}\n\nIs your guest one of them? Say which (like "the first one"), or say "add ${name} as a new person". I prepared nothing for ${name} yet.`;
	});
	return say(
		[...lines, ...(proposals.length ? [`Attendance and decisions stay as recorded. ${wait}`] : [])].join("\n\n"),
	);
}

/**
 * Correcting Launch Sunday's recorded outcome (T-383): read it, then a card with only the fields the user named and
 * their reason. A request the Launch plan would refuse gets its words and no card.
 */
function correctStep(outputs: Output[], text: string): LanguageModelV4Content[] {
	const debrief = outputs.findLast((o) => o.operation === "launch.readDebrief");
	if (!debrief) return call("launch_read", { operation: "launch.readDebrief", input: {} });
	const f = debrief.facts ?? {};
	const last = outputs.at(-1);
	if (typeof last?.proposalId === "string") {
		const changes = ((last.rows?.[0]?.fields.changes ?? []) as { field: string; before: unknown; after: unknown }[])
			.filter((c) => c.field !== "reason")
			.map((c) => `${CORRECTED[c.field] ?? c.field} ${countSaid(c.before)} → ${countSaid(c.after)}`);
		return say(
			`I prepared a review card to correct Launch Sunday: ${changes.join(", ")}, with your reason. Anything you didn't name stays as recorded. Nothing changes until you approve it.`,
		);
	}
	if (f.recorded !== true)
		return say("Launch Sunday isn't recorded yet, so there's nothing to correct. Record it first. I prepared nothing.");
	const { fields, reason, unread } = correctionOf(text, String(f.today));
	const named = Object.keys(fields) as (keyof typeof fields)[];
	if (!named.length)
		return say("Tell me what to correct: the date it was held, attendance or decisions. I prepared nothing.");
	if (fields.actualDate === null) return say(`I couldn't read "${unread}" as a date. Say it like "Nov 8".`);
	if (fields.actualDate && fields.actualDate > String(f.today))
		return say("Launch Sunday can't be recorded for a date after today. I prepared nothing.");
	for (const k of ["attendance", "decisions"] as const) {
		const n = fields[k];
		if (typeof n === "number" && (!Number.isInteger(n) || n < 0 || n > 1_000_000))
			return say("Counts are whole numbers from 0 to 1,000,000. I prepared nothing.");
	}
	const was = (k: (typeof named)[number]) =>
		k === "actualDate"
			? fields.actualDate
				? launchDay(fields.actualDate) === f.actualDate
				: false
			: fields[k] === f[k];
	if (named.every(was))
		return say(
			`Launch Sunday already has ${named.map((k) => `${CORRECTED[k]} ${k === "actualDate" ? String(f.actualDate) : countSaid(f[k])}`).join(" and ")} on the Launch plan, so there's nothing to correct. I prepared nothing.`,
		);
	if (!reason)
		return say(
			"Why is Launch Sunday's outcome being corrected? The reason stays in Launch history, so tell me in your own words. I prepared nothing yet.",
		);
	if (reason.length > 2_000) return say("Keep the reason to 2,000 characters or fewer. I prepared nothing.");
	return call("propose_change", { operation: "launch.correctOutcome", input: { ...fields, reason } });
}
const CORRECTED: Record<string, string> = {
	actualDate: "the date held",
	attendance: "attendance",
	decisions: "decisions",
};

/** What Evry says once a milestone card is prepared, from the workspace read it was found in. */
function milestoneProposed(completing: boolean, m: Row | undefined) {
	const wait = "Nothing changes until you approve it.";
	const label = m?.label ?? "the milestone";
	if (!completing) return `I prepared a review card to reopen **${label}**. Its prep tasks stay as they are. ${wait}`;
	const open = Number(m?.fields.openTasks ?? 0);
	const tasks = open
		? ` ${open} of its ${String(m?.fields.total)} prep tasks ${open === 1 ? "is still open and stays" : "are still open and stay"} open.`
		: "";
	const review = m?.fields.needsReview === true ? " It confirms the earlier completion." : "";
	return `I prepared a review card to mark **${label}** complete.${tasks}${review} ${wait}`;
}

/** What Evry says once a review card is prepared: what it shows, and that nothing changes before approval. */
function proposedText(asked: Record<string, boolean>, out: Output) {
	const [plan] = (out.rows ?? []) as Row[];
	const changes = (plan?.fields.changes ?? []) as { field: string; before: unknown; after: unknown }[];
	const of = (field: string) => changes.find((c) => c.field === field);
	const wait = "Nothing changes until you approve it.";
	if (asked.move) {
		const date = of("launchDate");
		return `I prepared a review card to move Launch Sunday from ${String(date?.before ?? "no date")} to ${String(date?.after)}, with your reason. Prep tasks and your phase stay as they are. ${wait}`;
	}
	if (asked.postpone) return `I prepared a review card to postpone the launch, with your reason. ${wait}`;
	if (asked.record)
		return `I prepared a review card to record Launch Sunday${of("attendance") ? ` with attendance ${String(of("attendance")!.after)}` : ""}${of("guestAnswer") ? ` and the debrief's guest answer "${String(of("guestAnswer")!.after)}"` : ""}. No people are created from these numbers. ${wait}`;
	if (asked.submit)
		return `I prepared a review card to submit the Launch debrief. Submitting publishes nothing. ${wait}`;
	const body = of("summary")?.after;
	return `I prepared a review card to publish this summary, exactly as your sending church and network will see it:\n\n${String(
		body,
	)
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n")}\n\n${wait}`;
}
