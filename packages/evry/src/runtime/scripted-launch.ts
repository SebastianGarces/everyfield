import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { LAUNCH_RULES } from "../context/compile.ts";

// The scripted model's Launch requests (WP-075, WP-076), for local previews and tests only. It answers through the same
// tools a model gets: the countdown, milestones, history and Launch Sunday as the Launch plan reads them, and review
// cards for a date move, a postponement, Launch Sunday's numbers, the debrief and the summary. Every number it says is
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
	if (!rows.length) return `Launch history shows no changes since ${String(since)}.${quoted}`;
	const lines = rows.map((r) => {
		const f = r.fields;
		const what =
			f.change === "date" ? `${r.label} from ${String(f.from ?? "no date")} to ${String(f.to ?? "no date")}` : r.label;
		return `- ${what}, by ${String(f.by)} on ${String(f.on)}${typeof f.reason === "string" ? ` (reason: "${f.reason}")` : ""}`;
	});
	return `Since ${String(since)}, Launch history shows:\n${lines.join("\n")}\n\n${quoted.trim()}`.trim();
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
	};
	if (!Object.values(asked).some(Boolean)) return null;
	if (last?.error) return say(`I couldn't do that (${String(last.error)}).`);
	// A launch read that could not load the plan: never an answer that there is no launch.
	if (last?.facts?.loaded === false) return rule(LAUNCH_RULES.unloaded);
	const writes = asked.move || asked.postpone || asked.record || asked.submit || asked.publish;
	if (writes && !offers("launch.schedule")) return rule(LAUNCH_RULES.ownerOnly);
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
