import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";

// The scripted model's Overview and feedback requests (T-330), for local previews and tests only. It answers through the
// same tools a model gets: "what should I focus on this week?" reads Overview's next steps and counts, the week's
// meetings and the pipeline, and says where each item came from and what it could not cover; "who did we add in the last
// month?" reads Overview's activity; "what's missing in our setup?" reads the setup gaps; and feedback is proposed for
// review, then read back from the user's own sent feedback. Every item it names is a row a read returned. The coverage
// line is the system prompt's own (compile.ts), so the evals test the words the real model is given.

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { kind: string; id: string; label: string; fields: Record<string, unknown> };
type Output = Record<string, unknown> & {
	operation?: string;
	status?: string;
	error?: string;
	rows?: Row[];
	facts?: Record<string, unknown>;
	exclusions?: string[];
	completeness?: string;
};

const call = (toolName: string, operation: string, input: unknown = {}): LanguageModelV4Content[] => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify({ operation, input }) },
];
const say = (...lines: string[]): LanguageModelV4Content[] => [{ type: "text", text: lines.join("\n") }];
const propose = (operation: string, input: unknown): LanguageModelV4Content[] => [
	{
		type: "tool-call",
		toolCallId: randomUUID(),
		toolName: "propose_change",
		input: JSON.stringify({ operation, input }),
	},
];

/** The JSON tool results of the current turn, oldest first (everything after the last user message). */
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

const FOCUS = /\bwhat should (?:i|we) focus on\b|\bfocus on this week\b/i;
const ADDED = /\bwho (?:did we|have we) add(?:ed)?\b|\bwho (?:was|were|got) added\b/i;
const MISSING = /\bwhat(?:'s| is) (?:missing|left|still open) in (?:our|my|the) set ?up\b|\bset ?up gaps\b/i;
const SEND = /\b(?:send|give|leave|submit)\s+(?:some\s+)?feedback\s+(?:that|saying)\s+(.+?)[.!]?\s*$/i;
const SENT = /\bwhat feedback (?:have|did) (?:i|we) sen[dt]\b|\bmy sent feedback\b/i;
const STATUS = /\bstatus of (?:my|that|the) feedback\b|\bfeedback(?:'s)? status\b|\bhappened to my feedback\b/i;
const UUID = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

// ---- Dates: church-local days as YYYY-MM-DD ----
const at = (day: string) => new Date(`${day}T12:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => iso(new Date(at(day).getTime() + n * 86_400_000));
/** The same day one month earlier, or that month's last day. */
function monthBefore(day: string) {
	const [y, m, d] = day.split("-").map(Number) as [number, number, number];
	const last = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
	return iso(new Date(Date.UTC(y, m - 2, Math.min(d, last), 12)));
}
const short = (day: string) =>
	new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(at(day));
/** Today in the church's time zone, from the trusted server clock the system prompt states. */
function churchToday(prompt: Prompt, zone: string) {
	const clock = /Current time \(trusted server clock\): (\S+?)\.?(?:\s|$)/.exec(systemText(prompt))?.[1];
	return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(clock ? new Date(clock) : new Date());
}

/** What each read covers, named the way the week answer names it when that read failed. */
const AREA: Record<string, string> = {
	"dashboard.availableActions": "Overview's next steps",
	"dashboard.metrics": "your overdue task count (Tasks)",
	"meetings.list": "this week's meetings (Meetings)",
	"people.getPipelineData": "the People pipeline",
};
const WEEK_READS = [
	["dashboard_read", "dashboard.availableActions", {}],
	["dashboard_read", "dashboard.metrics", {}],
	["meetings_read", "meetings.list", { window: "upcoming", limit: 50 }],
	["peopleOrganization_read", "people.getPipelineData", {}],
] as const;
const FOLLOW_UP: Record<string, string> = { warning: "no recent activity", alert: "no activity for a long while" };

/** The week answer: each read's items with where they came from, then what it could not cover. */
function weekAnswer(prompt: Prompt, outputs: Output[]) {
	const of = (operation: string) => outputs.findLast((o) => o.operation === operation);
	const ok = (o: Output | undefined) => o && !o.error && o.status === "available";
	const frame = of("dashboard.availableActions");
	const zone = String(of("dashboard.activity")?.facts?.timeZone ?? "America/Chicago");
	const today = ok(frame) ? String(frame!.facts?.today) : churchToday(prompt, zone);
	const end = addDays(today, 6);
	const lines = [`Here is your week, ${short(today)} to ${short(end)}, from what Everyfield has recorded:`];

	if (ok(frame)) {
		const steps = frame!.rows ?? [];
		if (steps.length) {
			lines.push("", "**Next steps** (from Overview):");
			for (const s of steps) lines.push(`- [${s.label}](${String(s.fields.href)})`);
		} else if (frame!.facts?.role === "member")
			lines.push("", "Overview offers your seat no next steps: an Owner or Admin takes those (from Overview).");
		else lines.push("", "Overview has no next steps for you right now (from Overview).");
	}
	const meetings = of("meetings.list");
	if (ok(meetings)) {
		const week = (meetings!.rows ?? []).filter(
			(m) => m.kind === "meeting" && String(m.fields.date) >= today && String(m.fields.date) <= end,
		);
		if (week.length) {
			lines.push("", "**Meetings this week** (from Meetings):");
			for (const m of week)
				lines.push(
					`- [${m.label}](/meetings/${m.id}), ${String(m.fields.when)}${m.fields.status === "cancelled" ? " (cancelled)" : ""}`,
				);
		} else lines.push("", "No meeting is scheduled this week (from Meetings).");
	}
	const pipeline = of("people.getPipelineData");
	if (ok(pipeline)) {
		// Marked by the board's own inactivity rule, listed by name: no one is ranked. The user is never someone to follow up with.
		const marked = (pipeline!.rows ?? [])
			.filter((p) => p.kind === "person" && FOLLOW_UP[String(p.fields.inactivity)] && p.fields.you !== true)
			.sort((a, b) => a.label.localeCompare(b.label));
		if (marked.length) {
			lines.push("", "**People to follow up with** (from People: the pipeline marks them for inactivity):");
			for (const p of marked) lines.push(`- [${p.label}](/people/${p.id}), ${FOLLOW_UP[String(p.fields.inactivity)]}`);
		} else lines.push("", "The pipeline marks no one for follow-up (from People).");
	}
	const metrics = of("dashboard.metrics");
	if (ok(metrics)) {
		const overdue = Number(metrics!.facts?.myOverdueTasks ?? 0);
		lines.push(
			"",
			overdue
				? `**Overdue tasks** (from Tasks): you have ${overdue} overdue ${overdue === 1 ? "task" : "tasks"}. [Open My tasks](/tasks?view=my)`
				: "You have no overdue tasks (from Tasks).",
		);
	}
	const failed = WEEK_READS.filter(([, op]) => !ok(of(op))).map(([, op]) => AREA[op]!);
	if (failed.length)
		lines.push(
			"",
			`I couldn't read ${failed.join(", ")} just now, so this answer doesn't cover ${failed.length === 1 ? "it" : "them"}. Ask again in a moment.`,
		);
	const coverage = /Not covered yet: [^\n]*/.exec(systemText(prompt))?.[0];
	if (coverage) lines.push("", coverage);
	return say(...lines);
}

/** "Who did we add in the last month?": the "added to People" entries of Overview's activity since a month ago. */
function addedAnswer(prompt: Prompt, activity: Output) {
	if (activity.error)
		return say("I couldn't read Overview's activity just now, so I can't say who was added. Open [People](/people).");
	if (activity.status !== "available") return say(activity.exclusions?.[0] ?? "I can't read this church's Overview.");
	const today = churchToday(prompt, String(activity.facts?.timeZone));
	const since = monthBefore(today);
	const entries = activity.rows ?? [];
	const added = entries.filter((e) => e.fields.change === "person_added" && String(e.fields.date) >= since);
	// The feed holds the latest 20 changes. When older ones exist and even the oldest shown is inside the month, the
	// month may reach past what it returned.
	const oldest = entries.at(-1);
	const cut = activity.facts?.more === true && (!oldest || String(oldest.fields.date) >= since);
	const lines = added.length
		? [
				`${added.length} ${added.length === 1 ? "person was" : "people were"} added to People in the last month (since ${short(since)}), as Overview's activity shows:`,
				...added.map(
					(e) =>
						`- [${e.label.replace(/ added to People$/, "")}${e.fields.you === true ? " (you)" : ""}](${String(e.fields.href)}), added ${short(String(e.fields.date))}`,
				),
			]
		: [`No one was added to People in the last month (since ${short(since)}), as Overview's activity shows.`];
	lines.push(
		"",
		cut
			? "Overview's activity keeps only the latest 20 changes, so this list may be incomplete. Open [People](/people) to see everyone."
			: `That is everyone added since ${short(since)}.`,
	);
	return say(...lines);
}

/** "What's missing in our setup?": the open setup steps Overview lists, each with its link. */
function gapsAnswer(gaps: Output) {
	if (gaps.error) return say("I couldn't read your setup steps just now. Open [Overview](/overview) to see them.");
	if (gaps.status !== "available") return say(gaps.exclusions?.[0] ?? "I can't read this church's Overview.");
	const rows = gaps.rows ?? [];
	if (!rows.length) return say("Every setup step Overview lists is done.");
	const linked = rows.every((r) => typeof r.fields.href === "string");
	return say(
		`Overview lists ${rows.length} setup ${rows.length === 1 ? "step" : "steps"} still open:`,
		...rows.map((r) => (typeof r.fields.href === "string" ? `- [${r.label}](${r.fields.href})` : `- ${r.label}`)),
		...(linked ? [] : ["", "An Owner or Admin of this church takes these steps."]),
	);
}

/** The feedback type its words suggest: something broke, an idea, a question, or other. */
function categoryOf(words: string) {
	if (/\b(broken|broke|bug|error|crash(?:es|ed)?|doesn['’]?t work|does not work|fails?|failed)\b/i.test(words))
		return "bug";
	if (/\?\s*$/.test(words) || /^(?:how|why|what|when|where|can|could|is|are|does|do)\b/i.test(words)) return "question";
	if (/\b(should|could you|please add|i wish|would be (?:nice|great)|it would help)\b/i.test(words))
		return "suggestion";
	return "other";
}
const sentence = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);
const feedbackLine = (r: Row) => `- ${r.label}, sent ${String(r.fields.sent)}: ${String(r.fields.status)}`;

/** One step of an Overview or feedback request, or null when it is none. */
export function overviewStep(options: LanguageModelV4CallOptions, text: string): LanguageModelV4Content[] | null {
	const tools = JSON.stringify(options.tools ?? []);
	const offers = (operation: string) => tools.includes(`"${operation}"`);
	const outputs = turnOutputs(options.prompt);
	const last = outputs.at(-1);
	const of = (operation: string) => outputs.findLast((o) => o.operation === operation);

	if (FOCUS.test(text) && offers("dashboard.availableActions")) {
		const next = WEEK_READS.find(([, op]) => offers(op) && !of(op));
		return next ? call(next[0], next[1], next[2]) : weekAnswer(options.prompt, outputs);
	}
	if (ADDED.test(text) && offers("dashboard.activity")) {
		const activity = of("dashboard.activity");
		return activity ? addedAnswer(options.prompt, activity) : call("dashboard_read", "dashboard.activity");
	}
	if (MISSING.test(text) && offers("dashboard.readSetupGaps")) {
		const gaps = of("dashboard.readSetupGaps");
		return gaps ? gapsAnswer(gaps) : call("dashboard_read", "dashboard.readSetupGaps");
	}
	const send = SEND.exec(text);
	if (send && offers("feedback.submit")) {
		if (last && typeof last.proposalId === "string")
			return say(
				"Here is your feedback to review. It goes to the Everyfield team only once you approve it, and you'll find it in [Sent feedback](/feedback).",
			);
		if (last?.error) return say(`I couldn't prepare that feedback (${String(last.error)}).`);
		const words = sentence(send[1]!.trim());
		return propose("feedback.submit", { category: categoryOf(words), description: words });
	}
	if ((SENT.test(text) || STATUS.test(text)) && offers("feedback.listOwn")) {
		const id = UUID.exec(text)?.[1];
		const list = of("feedback.listOwn");
		const one = of("feedback.getOwnStatus");
		if (STATUS.test(text)) {
			if (id && !one) return call("feedback_read", "feedback.getOwnStatus", { feedbackId: id });
			if (!id && !list) return call("feedback_read", "feedback.listOwn");
			const newest = list?.rows?.[0];
			if (!id && !one && newest) return call("feedback_read", "feedback.getOwnStatus", { feedbackId: newest.id });
			const found = one?.rows?.[0];
			if (!found) return say("I can't find that feedback among what you've sent. Open [Sent feedback](/feedback).");
			return say(
				`Your feedback sent ${String(found.fields.sent)} (${found.label}) is ${String(found.fields.status)}.${typeof found.fields.publicIssue === "string" ? ` Its public issue: ${found.fields.publicIssue}` : ""} See it in [Sent feedback](/feedback).`,
			);
		}
		if (!list) return call("feedback_read", "feedback.listOwn");
		const rows = list.rows ?? [];
		if (!rows.length) return say("You haven't sent any feedback yet.");
		return say(
			`You have sent ${rows.length === 1 ? "1 piece" : `${rows.length} pieces`} of feedback${list.completeness === "partial" ? " that I can show" : ""}, newest first:`,
			...rows.map(feedbackLine),
			"",
			"See them in [Sent feedback](/feedback).",
		);
	}
	return null;
}
