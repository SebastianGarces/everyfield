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
	if (/what (can|are) you (able to )?(do|help)|capabilit/i.test(text)) return "capabilities";
	return "application";
}
const systemText = (prompt: Prompt) => {
	const m = prompt.find((p) => p.role === "system");
	return m?.role === "system" ? m.content : "";
};

// Attached files (WP-054): the system prompt lists each one with its attachmentId, what is true of it now and its latest
// check. "check it" previews the newest file; "import it" proposes the import of the newest file with the latest check
// of a file by that name, so a file replaced since its check meets the runtime's refusal and is checked afresh.
type Listed = { id: string; name: string; status: "available" | "replaced" | "gone"; checked: string | null };
function attachedFiles(system: string): Listed[] {
	const out: Listed[] = [];
	for (const m of system.matchAll(/^- "([^"]+)" attachmentId ([0-9a-f-]{36}), attached [^\n]*? UTC: ([^\n]+)$/gm)) {
		const rest = m[3]!;
		out.push({
			id: m[2]!,
			name: m[1]!,
			status: rest.startsWith("available") ? "available" : rest.startsWith("replaced") ? "replaced" : "gone",
			checked: /checked: fileDigest ([0-9a-f]{64})/.exec(rest)?.[1] ?? null,
		});
	}
	return out;
}
function fileStep(text: string, system: string, result: Record<string, unknown> | null, canPropose: boolean) {
	const check = /\b(check|look at|review)\b.*\b(it|file|spreadsheet|csv)\b|\buploaded\b/i.test(text);
	const importing = /\bimport (it|the (file|spreadsheet|csv))\b/i.test(text);
	if (!check && !importing) return null;
	const files = attachedFiles(system);
	const newest = files[0];
	const say = (t: string) => [{ type: "text" as const, text: t }];
	if (result?.error === "attachment_gone" || (!result && newest?.status === "gone"))
		return say("That file is gone: attached files last 24 hours. Please attach it again here and I'll check it.");
	if (result?.error === "attachment_elsewhere" || (!result && !newest))
		return say("I can't see a file in this conversation. Attach it here with the paperclip and I'll check it.");
	if (result?.operation === "people.previewImport") {
		const rows = (result.rows as { kind: string; label: string; fields: Record<string, string | null> }[]) ?? [];
		const people = new Map(rows.filter((r) => r.kind === "person").map((r) => [(r as unknown as { id: string }).id, r.label]));
		const lines = rows
			.filter((r) => r.kind === "import")
			.map((r) =>
				r.fields.status === "invalid"
					? `- ${r.label}: can't be imported (${r.fields.problems})`
					: r.fields.duplicatePersonIds
						? `- ${r.label}: possible duplicate of ${r.fields.duplicatePersonIds
								.split(",")
								.map((id) => people.get(id) ?? "someone")
								.join(", ")}`
						: `- ${r.label}: valid, ready to add`,
			);
		const fresh = importing ? "The file changed since I checked it, so here is a fresh check. " : "";
		return say(`${fresh}I checked the file. Nothing is imported.\n${lines.join("\n")}`);
	}
	if (result?.error === "file_changed" && newest)
		return [toolCall("peopleOrganization_read", { operation: "people.previewImport", input: { attachmentId: newest.id } })];
	if (typeof result?.proposalId === "string")
		return say("I prepared the import for your review. People stays as it is until you approve it.");
	if (result) return null;
	if (importing && canPropose && newest) {
		const digest = files.find((f) => f.name.toLowerCase() === newest.name.toLowerCase() && f.checked)?.checked;
		if (!digest)
			return [toolCall("peopleOrganization_read", { operation: "people.previewImport", input: { attachmentId: newest.id } })];
		return [
			toolCall("propose_change", {
				operation: "people.executeBulkImport",
				input: { attachmentId: newest.id, fileDigest: digest },
			}),
		];
	}
	return [toolCall("peopleOrganization_read", { operation: "people.previewImport", input: { attachmentId: newest!.id } })];
}

// Dates (WP-085): "Nov 1 at 1:30am" is checked against the church's calendar before anything uses it.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function dateStep(text: string, result: Record<string, unknown> | null, canRead: boolean) {
	const say = (t: string) => [{ type: "text" as const, text: t }];
	if (/\bthe \d{1,2}(st|nd|rd|th)\b|-ish\b/i.test(text) && !result)
		return say("Which date do you mean? Tell me the month and day, and I'll check it against the church's calendar.");
	const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:,? (\d{4}))? at (\d{1,2}):(\d{2})\s*(am|pm)\b/i.exec(text);
	if (!m || !canRead) return null;
	if (!result) {
		const year = m[3] ?? String(new Date().getUTCFullYear());
		const h = (Number(m[4]) % 12) + (/^p/i.test(m[6]!) ? 12 : 0);
		const date = `${year}-${String(MONTHS.indexOf(m[1]!.toLowerCase().slice(0, 3)) + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
		return [toolCall("calendar_read", { operation: "calendar.resolve", input: { date, time: `${String(h).padStart(2, "0")}:${m[5]}` } })];
	}
	const fields = (result.rows as { fields: Record<string, string> }[] | undefined)?.[0]?.fields;
	if (!fields) return null;
	if (fields.status === "ambiguous")
		return say(`That time happens twice that day as the clocks fall back. Do you mean ${fields.option1} (the first) or ${fields.option2} (the second)?`);
	if (fields.status === "nonexistent")
		return say(`That time doesn't exist that day in ${fields.zone}: the clocks skip it. What time would you like instead?`);
	if (fields.status === "exact") return say(`That is ${fields.shows}.`);
	return say("That isn't a real date. Which date do you mean?");
}

// Honest limits (EVR-007, META-01, SAF-02, SAF-06, SAF-16, SAF-17) and saved outcomes (GAP-EVR-429).
function limitStep(text: string, system: string, result: Record<string, unknown> | null, canPropose: boolean) {
	const say = (t: string) => [{ type: "text" as const, text: t }];
	if (/background check/i.test(text)) return say("Everyfield doesn't track background checks, so I have nothing to look up for that.");
	if (/\bdid you send\b|\bwas it sent\b/i.test(text)) {
		const lines = [...system.matchAll(/^- (communication\.\w+) for "([^"]+)" \(proposalId [^)]+\): (.+)$/gm)].map(
			([, op, subject, state]) =>
				`- "${subject}": ${/^waiting/.test(state!) ? "not sent, waiting for your review" : /sent to the email service/.test(state!) ? (/delivery not confirmed/.test(state!) ? "sent, delivery not confirmed yet" : "sent and delivered") : state}${op === "communication.saveDraft" ? " (draft)" : ""}`,
		);
		return say(lines.length ? lines.join("\n") : "Nothing was sent from this conversation.");
	}
	if (!canPropose && /\b(move|change|set|update|delete|remove|add)\b/i.test(text) && /Only an Owner or Admin/.test(system))
		return say("An Owner or Admin of this church has to make that change. I can't prepare it for you.");
	const bulk = /\b(delete|remove) (everyone|everybody|all) in (\w+)/i.exec(text);
	if (bulk && canPropose) {
		if (!result) return [toolCall("people_read", { operation: "people.listPeople", input: { stages: [bulk[3]!.toLowerCase()], limit: 1 } })];
		if (result.operation === "people.listPeople")
			return say(`That would remove all ${String(result.total)} people in ${bulk[3]}. Do you want me to prepare those removals? Tell me to go ahead, or name who to keep.`);
	}
	return null;
}

// History (EVR-031): find the one person, then read their history page by page, each item with its date.
function historyStep(text: string, result: Record<string, unknown> | null) {
	const m = /\b(?:everything that'?s happened|history) (?:with|of|for) ([A-Z][\w'-]+(?: [A-Z][\w'-]+)?)/.exec(text);
	if (!m) return null;
	const page = Number(/\bpage (\d+)/i.exec(text)?.[1] ?? 1);
	if (!result) return [toolCall("people_read", { operation: "people.listPeople", input: { search: m[1] } })];
	if (result.operation === "people.listPeople") {
		const rows = (result.rows as { id: string; label: string }[]) ?? [];
		if (rows.length !== 1) return null;
		return [toolCall("peopleOrganization_read", { operation: "people.getActivities", input: { personId: rows[0]!.id, page, limit: 10 } })];
	}
	if (result.operation !== "people.getActivities") return null;
	const rows = (result.rows as { label: string; fields: Record<string, string | null> }[]) ?? [];
	const lines = rows.map((r) => `- ${String(r.fields.occurredAt).slice(0, 10)}: ${r.label}${r.fields.to ? ` (to ${r.fields.to})` : ""}`);
	const more = typeof result.next === "number" ? `\nThere is more. Ask for page ${result.next} of ${m[1]}'s history.` : "";
	return [{ type: "text" as const, text: `${m[1]}'s history, page ${result.page}:\n${lines.join("\n") || "- nothing recorded"}${more}` }];
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
	const system = systemText(options.prompt);
	const canReadMail = options.tools?.some((t) => t.name === "communication_read") ?? false;
	const steps =
		limitStep(text, system, result, canPropose) ??
		fileStep(text, system, result, canPropose) ??
		dateStep(text, result, options.tools?.some((t) => t.name === "calendar_read") ?? false) ??
		historyStep(text, result) ??
		emailStep(text, canPropose, canReadMail, result);
	if (steps) return steps;
	if (result && typeof result.proposalId === "string" && (DRAFT.test(text) || EMAIL_REVIEW.test(text)))
		return [{ type: "text", text: "I prepared a review. Nothing is saved or sent until you approve it." }];
	if (result) {
		if (result.error === "already_applied")
			return [{ type: "text", text: "That change was already applied in this conversation, so I didn't prepare it again." }];
		if (result.error) return [{ type: "text", text: `I could not finish that read (${String(result.error)}).` }];
		if (result.operation === "people.listPeople" && result.total === 0 && !/\b(find|named|called)\b/i.test(text))
			return [
				{
					type: "text",
					text: "You have 0 people in this church so far. Want the People import template? Fill it in and attach it here, and I'll check it before anything is imported.",
				},
			];
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
