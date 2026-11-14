import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4Content,
	LanguageModelV4GenerateResult,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";

// A deterministic stand-in for a qualified model, for local previews and tests only (selectQualifiedModel never picks
// it on Vercel). It reads the conversation the way a model would see it and answers through the same tools, so the
// runtime, its limits, fences and stream are exercised end to end without a paid provider. It is not policy: the
// runtime enforces the boundary and limits whatever the model says.

type Prompt = LanguageModelV4CallOptions["prompt"];
const lastUserText = (prompt: Prompt) => {
	for (let i = prompt.length - 1; i >= 0; i--) {
		const m = prompt[i]!;
		if (m.role === "user")
			return m.content
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join(" ");
	}
	return "";
};
const lastToolOutput = (prompt: Prompt): Record<string, unknown> | null => {
	const m = prompt.at(-1);
	if (m?.role !== "tool") return null;
	const part = m.content.findLast((p) => p.type === "tool-result");
	if (!part || part.type !== "tool-result") return null;
	if (part.output.type === "json") return part.output.value as Record<string, unknown>;
	return part.output.type === "text" ? { text: part.output.value } : { error: part.output.type };
};
const toolCall = (toolName: string, input: unknown): LanguageModelV4Content => ({
	type: "tool-call",
	toolCallId: randomUUID(),
	toolName,
	input: JSON.stringify(input),
});

const pageSize = (text: string) =>
	Number(/\b(\d{1,3}) at a time\b/.exec(text)?.[1] ?? (/\b(?:every|all)\b/i.test(text) ? 100 : 24));

function classify(text: string) {
	if (/\b(pray|prayer|biblical|scripture|spiritual(ly)?|pastoral(ly)?|suitab)/i.test(text)) return "pastoral_boundary";
	if (/what can you (do|help)|capabilit/i.test(text)) return "capabilities";
	return "application";
}

// Email requests (MAIL51-009): "draft an email to the launch team", "schedule it for Friday at 9am", "move the Friday
// email to Saturday at 9am", "cancel the Friday email", "replace the body of the Friday email with: ...". The same
// tools a model uses: find the message with a read, then propose the reviewed change.
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** The next date (UTC calendar) of a weekday name, from today: "friday" is never today. */
function nextDate(day: string, now = new Date()) {
	const ahead = (DAYS.indexOf(day.toLowerCase()) - now.getUTCDay() + 7) % 7 || 7;
	return new Date(now.getTime() + ahead * 86_400_000).toISOString().slice(0, 10);
}
function clock(hour: string, am: string) {
	const h = (Number(hour) % 12) + (/^p/i.test(am) ? 12 : 0);
	return `${String(h).padStart(2, "0")}:00`;
}
const DAY = `(${DAYS.join("|")})`;
const DRAFT = /\bdraft an email to the launch team\b/i;
const EMAIL_REVIEW = /\b(schedule|move|cancel|replace|change the \w+ email)\b/i;
function emailStep(text: string, canPropose: boolean, canRead: boolean, result: Record<string, unknown> | null) {
	if (!canPropose) return null;
	const schedule = new RegExp(`\\bschedule it for ${DAY} at (\\d{1,2})\\s*(am|pm)\\b`, "i").exec(text);
	const relative = /\bschedule it for (yesterday|\d{1,3} days from now) at (\d{1,2})\s*(am|pm)\b/i.exec(text);
	const move = new RegExp(`\\bmove the ${DAY} email to ${DAY} at (\\d{1,2})\\s*(am|pm)\\b`, "i").exec(text);
	const cancel = new RegExp(`\\bcancel the ${DAY} email\\b`, "i").exec(text);
	const body = new RegExp(`\\breplace the body of the ${DAY} email with:\\s*(.+)$`, "is").exec(text);
	const audience = new RegExp(`\\bchange the ${DAY} email to go to the launch team\\b`, "i").exec(text);
	const propose = (operation: string, input: unknown) => [toolCall("propose_change", { operation, input })];
	if (DRAFT.test(text) && !result)
		return propose("communication.saveDraft", {
			subject: "Sunday's interest meeting",
			body: "Hi {{name}},\n\nWe are holding an interest meeting on Sunday at 4 pm. Please come and bring a friend.\n\nSee you there.",
			audience: { groups: ["launch_team"] },
		});
	const target = schedule ?? relative ?? move ?? cancel ?? body ?? audience;
	if (!target || !canRead) return null;
	if (!result)
		return [
			toolCall("communication_read", {
				operation: "communication.list",
				input: schedule || relative ? { state: "draft" } : { state: "scheduled", sendOn: nextDate(target[1]!) },
			}),
		];
	const first = (result.rows as { id: string }[] | undefined)?.[0];
	if (!first || typeof result.proposalId === "string") return null;
	const communicationId = first.id;
	if (schedule)
		return propose("communication.scheduleReviewed", {
			communicationId,
			sendAt: `${nextDate(schedule[1]!)}T${clock(schedule[2]!, schedule[3]!)}`,
		});
	if (relative) {
		const days = relative[1]!.toLowerCase() === "yesterday" ? -1 : Number(/\d+/.exec(relative[1]!)![0]);
		const date = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
		return propose("communication.scheduleReviewed", {
			communicationId,
			sendAt: `${date}T${clock(relative[2]!, relative[3]!)}`,
		});
	}
	if (move)
		return propose("communication.rescheduleReviewed", {
			communicationId,
			sendAt: `${nextDate(move[2]!)}T${clock(move[3]!, move[4]!)}`,
		});
	if (cancel) return propose("communication.cancelScheduledReviewed", { communicationId });
	return propose(
		"communication.replaceScheduledReviewed",
		body ? { communicationId, body: body[2]!.trim() } : { communicationId, audience: { groups: ["launch_team"] } },
	);
}

// Meetings requests (WP-065/066), each through the same tools a model uses: read the meetings, then answer from the rows
// or propose the reviewed change. "what are my upcoming meetings?", "who rsvp'd for thursday's vision night",
// "print the agenda for sunday", "what do I still need from the vision kit?", "are vision nights growing? last 3",
// "set up a vision meeting next thursday 7pm at the coffee shop" (then "the 22nd"), "add a walk-in, Luis, no last name",
// "mark Maria, Alex and Casey as attended and finalize it", "score last night's vision meeting for me" (then the eight
// scores) and "delete the <meeting>".
type Row = { kind: string; id: string; label: string; fields: Record<string, unknown> };
type Output = { operation?: string; rows?: Row[]; proposalId?: string; error?: string; status?: string };
/** Every tool result since the last user message, in order. */
function turnOutputs(prompt: Prompt): Output[] {
	const out: Output[] = [];
	for (let i = prompt.length - 1; i >= 0; i--) {
		const m = prompt[i]!;
		if (m.role === "user") break;
		if (m.role === "tool")
			for (const p of m.content)
				if (p.type === "tool-result" && p.output.type === "json") out.unshift(p.output.value as Output);
	}
	return out;
}
/** The user's earlier messages in this conversation, oldest first, without the last one. */
function earlierUserTexts(prompt: Prompt) {
	const texts = prompt
		.filter((m) => m.role === "user")
		.map((m) => (m.content as { type: string; text?: string }[]).map((p) => p.text ?? "").join(" "));
	return texts.slice(0, -1);
}
const read = (operation: string, input: unknown) => [toolCall("meetings_read", { operation, input })];
const propose = (operation: string, input: unknown) => [toolCall("propose_change", { operation, input })];
const say = (text: string): LanguageModelV4Content[] => [{ type: "text", text }];
const zone = "America/Chicago";
const localToday = () =>
	new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
		new Date(),
	);
const addDays = (date: string, n: number) =>
	new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const dayName = (date: string) =>
	new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(
		new Date(`${date}T12:00:00Z`),
	);
/** The next `day` (0 = Sunday) on or after tomorrow, church-local. */
const nextWeekday = (day: number, from = localToday()) => addDays(from, (day - weekday(from) + 7) % 7 || 7);
const RSVP_GROUPS = [
	["yes", "RSVP yes"],
	["no", "RSVP no"],
	["no answer", "No answer yet"],
] as const;
const SCORE_WORDS = ["attendance", "location", "logistics", "agenda", "vibe", "message", "close", "next steps"];
const FACTORS = [
	"attendanceScore",
	"locationScore",
	"logisticsScore",
	"agendaScore",
	"vibeScore",
	"messageScore",
	"closeScore",
	"nextStepsScore",
];
const meetingLine = (r: Row) =>
	`${r.label}: ${String(r.fields.when)}${r.fields.venue ? ` at ${String(r.fields.venue)}` : ""}${r.fields.status === "cancelled" ? " (cancelled)" : ""}`;
const MEETINGS_INTENT =
	/\bupcoming meetings\b|\brsvp'?d for\b|\bagenda for \w+|\bvision kit\b|\bvision nights? growing\b|\bset up a vision meeting\b|\badd a walk-in\b|\bas attended and finalize\b|\bscore last night'?s vision meeting\b/i;
const rowsOf = (o: Output | undefined, kind?: string) => (o?.rows ?? []).filter((r) => !kind || r.kind === kind);

function meetingsStep(
	text: string,
	prompt: Prompt,
	tools: LanguageModelV4CallOptions["tools"],
): LanguageModelV4Content[] | null {
	const canRead = tools?.some((t) => t.name === "meetings_read") ?? false;
	if (!canRead) return null;
	const proposeTool = tools?.find((t) => t.name === "propose_change");
	const can = (op: string) => !!proposeTool && JSON.stringify(proposeTool).includes(op);
	const earlier = earlierUserTexts(prompt).join("\n");
	const pickedDay = /^(?:the )?(\d{1,2})(?:st|nd|rd|th)?\.?$|\bthursday,? (\w+ \d{1,2})\b/i.exec(text.trim());
	// The latest earlier request to set one up, so a reply such as "the 19th" answers the question just asked.
	const asked =
		earlierUserTexts(prompt)
			.reverse()
			.map((t) => /\bset up a vision meeting next thursday (\d{1,2})\s*(am|pm) at the (.+?)\.?$/i.exec(t))
			.find(Boolean) ?? null;
	const scores = SCORE_WORDS.map((w) => Number(new RegExp(`\\b${w}\\s*(\\d)\\b`, "i").exec(text)?.[1]));
	const scored = scores.every((n) => n >= 1 && n <= 5) && /\bscore last night'?s vision meeting\b/i.test(earlier);
	const deleting = /\bdelete\b/i.test(text) && !can("meetings.delete");
	if (!MEETINGS_INTENT.test(text) && !(pickedDay && asked) && !scored && !deleting) return null;
	const outputs = turnOutputs(prompt);
	const last = outputs.at(-1);
	if (typeof last?.proposalId === "string") return say("I prepared a review. Nothing changes until you approve it.");
	if (last?.error) return say(`I could not finish that (${last.error}).`);

	if (/\bupcoming meetings\b/i.test(text)) {
		if (!outputs.length) return read("meetings.list", { window: "upcoming" });
		const rows = rowsOf(last, "meeting");
		if (!rows.length) return say("You have no upcoming meetings in Meetings.");
		return say(
			`Your upcoming meetings, as Meetings lists them:\n\n${rows.map((r) => `- ${meetingLine(r)}`).join("\n")}`,
		);
	}
	const rsvp = /\brsvp'?d for (.+?)\??$/i.exec(text);
	if (rsvp) {
		if (!outputs.length) return read("meetings.list", { window: "upcoming" });
		const wanted = rsvp[1]!.replace(/'s\b/g, "").toLowerCase();
		if (outputs.length === 1) {
			const rows = rowsOf(last, "meeting");
			const day = DAYS.find((d) => wanted.includes(d));
			const matches = rows.filter((r) =>
				day
					? weekday(String(r.fields.date)) === DAYS.indexOf(day) &&
						/vision/i.test(`${r.label} ${String(r.fields.type)}`)
					: r.label.toLowerCase().includes(wanted.replace(/^the /, "")),
			);
			if (matches.length > 1)
				return say(
					`${matches.length} meetings are called ${matches[0]!.label}: ${matches.map((m) => String(m.fields.when)).join(" and ")}. Which one do you mean?`,
				);
			if (!matches.length) return say("I can't find that meeting in Meetings.");
			return read("meetings.listGuests", { meetingId: matches[0]!.id });
		}
		const guests = rowsOf(last, "person");
		const groups = RSVP_GROUPS.map(([value, title]) => {
			const names = guests.filter((g) => g.fields.rsvp === value).map((g) => g.label);
			return `- ${title}: ${names.length ? names.join(", ") : "nobody"}`;
		});
		return say(`RSVPs (answers to the invitation, not attendance):\n\n${groups.join("\n")}`);
	}
	if (/\bagenda for (\w+)/i.test(text)) {
		if (!outputs.length) return read("meetings.list", { window: "upcoming" });
		if (outputs.length === 1) {
			const day = /\bagenda for (\w+)/i.exec(text)![1]!.toLowerCase();
			const m = rowsOf(last, "meeting").find((r) => weekday(String(r.fields.date)) === DAYS.indexOf(day));
			return m
				? read("meetings.readAgenda", { meetingId: m.id })
				: say(`I can't find a meeting on ${day} in Meetings.`);
		}
		const [meeting, ...sections] = rowsOf(last);
		if (!sections.length) return say("That meeting has no saved agenda.");
		return say(
			`The saved agenda for ${meeting!.label}:\n\n${sections.map((s) => `${String(s.fields.order)}. ${s.label} (${String(s.fields.starts)}, ${String(s.fields.minutes)} min)`).join("\n")}\n\n[Print the agenda](${String(meeting!.fields.print)}) from the app.`,
		);
	}
	if (/\bvision kit\b/i.test(text)) {
		if (!outputs.length) return read("meetings.list", { window: "upcoming", types: ["vision_meeting"] });
		if (outputs.length === 1) {
			const m = rowsOf(last, "meeting")[0];
			return m
				? read("meetings.listKit", { meetingId: m.id, only: "unchecked" })
				: say("No Vision meeting is coming up.");
		}
		const items = rowsOf(last, "item");
		return say(
			items.length
				? `Still unchecked in the kit:\n\n${items.map((i) => `- ${i.label}`).join("\n")}`
				: "Every kit item is checked.",
		);
	}
	const trend = /\bvision nights? growing\b.*?(\d+)?\s*$/i.exec(text);
	if (trend) {
		if (!outputs.length) return read("meetings.attendanceTrend", { limit: Number(/\d+/.exec(text)?.[0] ?? 3) });
		const points = rowsOf(last, "item");
		return say(
			`Attendance at the last ${points.length} Vision nights, oldest first:\n\n${points.map((p) => `- ${dayName(String(p.fields.date))}: ${p.fields.attended === "not recorded" ? "not recorded" : `${String(p.fields.attended)} attended`}`).join("\n")}\n\nA night with no attendance recorded is not counted as zero.`,
		);
	}
	const setUp = /\bset up a vision meeting next thursday (\d{1,2})\s*(am|pm) at the (.+?)\.?$/i.exec(text);
	if (setUp || (pickedDay && asked)) {
		const [, hour, ampm, place] = (setUp ?? asked)!;
		if (!outputs.length)
			return [toolCall("meetings_read", { operation: "venues.list", input: { search: place!.split(" ")[0] } })];
		const venues = rowsOf(outputs[0], "venue");
		if (venues.length !== 1)
			return say(
				venues.length
					? `More than one saved venue matches "${place}": ${venues.map((v) => v.label).join(", ")}. Which one?`
					: `I can't find a saved venue called "${place}". Which venue should it be, or should I save a new one?`,
			);
		const first = nextWeekday(4),
			second = addDays(first, 7);
		if (setUp)
			return say(
				`Do you mean ${dayName(first)} or ${dayName(second)}? I'll set it for ${hour} ${ampm!.toUpperCase()} Central at ${venues[0]!.label}.`,
			);
		const day = Number(pickedDay![1] ?? /\d+/.exec(pickedDay![2] ?? "")?.[0]);
		const date = [first, second].find((d) => Number(d.slice(8)) === day);
		if (!date) return say(`Do you mean ${dayName(first)} or ${dayName(second)}?`);
		return can("meetings.schedule")
			? propose("meetings.schedule", {
					type: "vision_meeting",
					date,
					time: clock(hour!, ampm!),
					venueId: venues[0]!.id,
				})
			: say("An Owner or Admin has to schedule that meeting.");
	}
	const walkIn = /\badd a walk-in,? ([A-Z][\w'-]+)/i.exec(text);
	if (walkIn) {
		if (!outputs.length) return read("meetings.list", { window: "upcoming", types: ["vision_meeting"] });
		const m = rowsOf(last, "meeting")[0];
		if (!m) return say("Which meeting should the walk-in be recorded at?");
		return can("meetings.createWalkInContact")
			? propose("meetings.createWalkInContact", { meetingId: m.id, displayName: walkIn[1] })
			: say("An Owner or Admin has to record a walk-in.");
	}
	const finalize = /\bmark (.+?) as attended and finalize\b/i.exec(text);
	if (finalize) {
		const names = finalize[1]!.split(/,\s*|\s+and\s+/).filter(Boolean);
		if (!outputs.length) return read("meetings.list", { window: "past", types: ["vision_meeting"] });
		if (outputs.length === 1) {
			const target = addDays(localToday(), -7);
			const m = [...rowsOf(last, "meeting")].sort(
				(a, b) =>
					Math.abs(Date.parse(String(a.fields.date)) - Date.parse(target)) -
					Math.abs(Date.parse(String(b.fields.date)) - Date.parse(target)),
			)[0];
			return m ? read("meetings.listAttendance", { meetingId: m.id }) : say("I can't find last week's Vision meeting.");
		}
		const [head, ...people] = rowsOf(last);
		const chosen = people.filter((p) => names.some((n) => p.label.toLowerCase().startsWith(n.toLowerCase())));
		const already = people.filter((p) => p.fields.presence === "attended");
		const ids = [...new Set([...already, ...chosen].map((p) => p.id))];
		if (chosen.length !== names.length)
			return say(`I can't find all of ${names.join(", ")} on that meeting's guest list.`);
		return propose("meetings.finalizeAttendance", { meetingId: head!.id, attendeeIds: ids });
	}
	if (/\bscore last night'?s vision meeting\b/i.test(text))
		return say(
			"The evaluation is your judgment, so I won't score it myself. Give me your 1-5 score for each factor (attendance, location, logistics, agenda, vibe, message, close and next steps) and I'll prepare it for you to approve.",
		);
	if (scored) {
		if (!outputs.length) return read("meetings.list", { window: "past", types: ["vision_meeting"], limit: 1 });
		const m = rowsOf(last, "meeting")[0];
		if (!m) return say("I can't find last night's Vision meeting.");
		return propose("meetings.recordEvaluation", {
			meetingId: m.id,
			scores: Object.fromEntries(FACTORS.map((f, i) => [f, scores[i]])),
		});
	}
	if (deleting) return say("Deleting a meeting needs an Owner or Admin. Ask one of them to delete it from Meetings.");
	return null;
}

const FORMATTING = /\bformatting demo\b/i;
const FORMATTING_ANSWER = [
	"There are **19 prospects** in this church, and the *list is complete*.",
	"",
	"Here is what I would check next:",
	"",
	"- Follow up with people who have no `next step` yet",
	"- Open the [People page](/people) to review each one",
	"",
	"1. Start with the newest prospects",
	"2. Then look at the longest waiting",
].join("\n");

function respond(options: LanguageModelV4CallOptions): LanguageModelV4Content[] {
	const text = lastUserText(options.prompt);
	if (options.responseFormat?.type === "json")
		return [{ type: "text", text: JSON.stringify({ kind: classify(text) }) }];
	// "Show a formatting demo": an answer with markdown, written slowly enough to watch it grow (local previews and tests).
	if (FORMATTING.test(text)) return [{ type: "text", text: FORMATTING_ANSWER }];
	const hasPeople = options.tools?.some((t) => t.name === "people_read") ?? false;
	const canPropose = options.tools?.some((t) => t.name === "propose_change") ?? false;
	// "Change Maria's city to Austin": find the person, then propose the change for review.
	const change = /\b(?:change|set|update)\s+([A-Z][\w'-]+?)(?:'s)?\s+(city|phone|email)\s+to\s+(.+?)\.?\s*$/i.exec(
		text,
	);
	const result = lastToolOutput(options.prompt);
	const canReadMail = options.tools?.some((t) => t.name === "communication_read") ?? false;
	const email = emailStep(text, canPropose, canReadMail, result);
	if (email) return email;
	const meetings = meetingsStep(text, options.prompt, options.tools);
	if (meetings) return meetings;
	if (result && typeof result.proposalId === "string" && (DRAFT.test(text) || EMAIL_REVIEW.test(text)))
		return [{ type: "text", text: "I prepared a review. Nothing is saved or sent until you approve it." }];
	if (result) {
		if (result.error) return [{ type: "text", text: `I could not finish that read (${String(result.error)}).` }];
		if (typeof result.proposalId === "string") {
			const [target] = result.rows as {
				label: string;
				fields: { changes: { field: string; before: unknown; after: unknown }[] };
			}[];
			if (!target) return [{ type: "text", text: "I prepared a change, but its source is no longer available." }];
			const changes = target.fields.changes.map(
				(c) => `${c.field} from ${String(c.before ?? "empty")} to ${String(c.after ?? "empty")}`,
			);
			return [
				{
					type: "text",
					text: `I prepared a change for ${target.label}: ${changes.join(", ")}. Nothing changes until you approve it.`,
				},
			];
		}
		const rows = (result.rows as { id: string; label: string; fields: { city: string | null } }[] | undefined) ?? [];
		if (change && canPropose && rows.length === 1)
			return [
				toolCall("propose_change", {
					operation: "people.updatePerson",
					input: { personId: rows[0]!.id, patch: { [change[2]!.toLowerCase()]: change[3] } },
				}),
			];
		// "every" asks for all pages: keep reading while the result says more exist; the runtime's budget stops it.
		if (/\bevery\b/i.test(text) && typeof result.next === "number")
			return [
				toolCall("people_read", {
					operation: "people.listPeople",
					input: { page: result.next, limit: pageSize(text) },
				}),
			];
		if (result.status === "not_found") return [{ type: "text", text: "I can't find that person in this church." }];
		const names = rows.map((r) => (r.fields.city ? `${r.label} (${r.fields.city})` : r.label));
		if (result.operation === "people.listHouseholds") {
			const count = rows.length;
			if (!count) return [{ type: "text", text: "No household in this church matches." }];
			const labels = rows.map((r) => r.label).join(", ");
			return [
				{ type: "text", text: `There ${count === 1 ? "is 1 household" : `are ${count} households`}: ${labels}.` },
			];
		}
		if ((/\bwhich\b|\bfind\b/i.test(text) || change) && rows.length > 1)
			return [{ type: "text", text: `I found ${rows.length} matches: ${names.join(", ")}. Which one do you mean?` }];
		const more = result.completeness === "partial" ? ` More exist; ask for page ${String(result.next)}.` : "";
		return [
			{ type: "text", text: `${String(result.total)} matched. Showing ${rows.length}: ${names.join(", ")}.${more}` },
		];
	}
	if (hasPeople) {
		const id = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(text)?.[1];
		if (id) return [toolCall("people_read", { operation: "people.getPerson", input: { personId: id } })];
		if (/\bhouseholds?\b/i.test(text) && options.tools?.some((t) => t.name === "peopleOrganization_read"))
			return [
				toolCall("peopleOrganization_read", { operation: "people.listHouseholds", input: { limit: pageSize(text) } }),
			];
		const name = change?.[1] ?? /\b(?:[Ff]ind|named|called|for)\s+([A-Z][\w'-]+)/.exec(text)?.[1];
		if (name) return [toolCall("people_read", { operation: "people.listPeople", input: { search: name } })];
		if (/\b(?:people|everyone|members?)\b/i.test(text))
			return [toolCall("people_read", { operation: "people.listPeople", input: { limit: pageSize(text) } })];
	}
	return [{ type: "text", text: "Ask me about the people in this church, for example: find Alex." }];
}

const usage = (options: LanguageModelV4CallOptions, content: LanguageModelV4Content[]) => {
	const input = Math.ceil(JSON.stringify(options.prompt).length / 4);
	const output = Math.ceil(JSON.stringify(content).length / 4);
	return {
		inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: output, text: output, reasoning: 0 },
	};
};

export function scriptedModel(): LanguageModelV4 {
	const generate = async (options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> => {
		const content = respond(options);
		return {
			content,
			finishReason: { unified: content.some((c) => c.type === "tool-call") ? "tool-calls" : "stop", raw: undefined },
			usage: usage(options, content),
			warnings: [],
		};
	};
	return {
		specificationVersion: "v4",
		provider: "evry",
		modelId: "scripted",
		supportedUrls: {},
		doGenerate: generate,
		async doStream(options) {
			const result = await generate(options);
			const pace = FORMATTING.test(lastUserText(options.prompt)) ? 45 : 10;
			const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
			for (const c of result.content)
				if (c.type === "text") {
					const id = randomUUID();
					parts.push({ type: "text-start", id });
					// Word-sized deltas, so a reader sees the reply arrive in pieces as a provider would send it.
					for (const word of c.text.match(/\S+\s*/g) ?? []) parts.push({ type: "text-delta", id, delta: word });
					parts.push({ type: "text-end", id });
				} else if (c.type === "tool-call") parts.push(c);
			parts.push({ type: "finish", finishReason: result.finishReason, usage: result.usage });
			return {
				stream: new ReadableStream({
					async start(controller) {
						for (const part of parts) {
							if (options.abortSignal?.aborted) break;
							controller.enqueue(part);
							if (part.type === "text-delta") await new Promise((r) => setTimeout(r, pace));
						}
						controller.close();
					},
				}),
			};
		},
	};
}
