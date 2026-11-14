import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4Content,
	LanguageModelV4GenerateResult,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { onboardingStep } from "./scripted-onboarding.ts";
import { settingsStep } from "./scripted-settings.ts";

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

// Notification requests (WP-081, WP-082), with the same tools a model uses. "Anything I missed" reads the unread feed
// and answers grouped by area with the count; reading never marks anything read. "Mark those three as read" marks the
// group of that size from the unread feed, and "mark all as read", "stop emailing me task reminders" and "send my digest
// daily" each propose their review. A digest choice Settings does not offer gets the choices that exist.
const AREA: Record<string, string> = {
	task_due: "Tasks",
	task_overdue: "Tasks",
	meeting_announcement: "Meetings",
	meeting_reminder: "Meetings",
};
const NUMBER: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
type Notice = { id: string; label: string; fields: { category?: string } };
const byArea = (rows: Notice[]) => {
	const groups = new Map<string, Notice[]>();
	for (const r of rows) {
		const area = AREA[r.fields.category ?? ""] ?? "Other";
		groups.set(area, [...(groups.get(area) ?? []), r]);
	}
	return [...groups];
};
function notificationStep(
	text: string,
	tools: { read: boolean; propose: boolean },
	result: Record<string, unknown> | null,
): LanguageModelV4Content[] | null {
	const missed = /\b(missed|unread notifications|what('|’)?s new)\b/i.test(text);
	const those = /\bmark (?:those|these|the) (\w+) (?:as )?read\b/i.exec(text);
	const all = /\bmark (?:all|everything)(?: (?:of them|notifications))? (?:as )?read\b/i.test(text);
	const email = /\bstop emailing me(?: about)? task reminders\b/i.test(text);
	const cadence = /\bsend my digest (daily|weekly)\b/i.exec(text);
	const other = /\bdigest\b.*\b(every \d+ hours?|hourly|monthly|twice a \w+)\b/i.test(text);
	const preview = /\bnext digest\b/i.test(text);
	const someone = /\b(?:change|turn off|stop)\b.*\b([A-Z][a-z]+)'s notifications?\b/.exec(text);
	if (!(missed || those || all || email || cadence || other || preview || someone)) return null;
	const propose = (operation: string, input: unknown) => [toolCall("propose_change", { operation, input })];
	const read = (operation: string, input: unknown) => [toolCall("notifications_read", { operation, input })];
	if (someone)
		return [
			{
				type: "text",
				text: `Each person sets their own notifications, so I can't change ${someone[1]}'s. I can change yours.`,
			},
		];
	if (other)
		return [
			{
				type: "text",
				text: "Your church digest can come daily or weekly. Those are the only choices Settings offers.",
			},
		];
	if (result && typeof result.proposalId === "string")
		return [{ type: "text", text: "I prepared a review. Nothing changes until you approve it." }];
	if (result?.error) return [{ type: "text", text: "I could not prepare that review." }];
	if (all && tools.propose) return propose("notifications.markAllVisibleRead", {});
	if (email && tools.propose)
		return propose("notifications.setPreferences", {
			choices: [
				{ category: "task_due", channel: "email", enabled: false },
				{ category: "task_overdue", channel: "email", enabled: false },
			],
		});
	if (cadence && tools.propose)
		return propose("notifications.digestCadence.set", { cadence: cadence[1]!.toLowerCase() });
	if (!tools.read) return null;
	if (preview) {
		if (!result) return read("notifications.previewPlanterDigest", {});
		const [head, ...lines] = (result.rows as { label: string; fields: Record<string, unknown> }[] | undefined) ?? [];
		if (!head) return [{ type: "text", text: "Your church digest is turned off, so no digest is coming." }];
		return [
			{
				type: "text",
				text: `${head.label}. It sends ${String(head.fields.sendsAt)} and covers ${String(head.fields.from)} to ${String(head.fields.to)}.\n\n${lines.map((l) => `- ${l.label}`).join("\n")}`,
			},
		];
	}
	if (!result) return read("notifications.feed", { unread: true });
	const groups = byArea((result.rows as Notice[] | undefined) ?? []);
	if (those && tools.propose) {
		const size = NUMBER[those[1]!.toLowerCase()] ?? Number(those[1]);
		const group = groups.find(([, rows]) => rows.length === size)?.[1];
		if (!group) return [{ type: "text", text: `Which ${those[1]} do you mean?` }];
		return propose("notifications.markSelectedRead", { noticeIds: group.map((r) => r.id) });
	}
	const total = Number(result.total ?? 0);
	if (!total) return [{ type: "text", text: "You have no unread notifications. Nothing was marked read." }];
	return [
		{
			type: "text",
			text: `You have ${total} unread ${total === 1 ? "notification" : "notifications"}:\n\n${groups
				.map(([area, rows]) => `- **${area} (${rows.length})**: ${rows.map((r) => r.label).join("; ")}`)
				.join("\n")}\n\nThey are still unread in your bell.`,
		},
	];
}

// Household, tag, note, skill and import requests (WP-064): "add Pedro to the Martinez household", "the nguyens moved
// to 123 oak st, update everyone", "tag Ana Rivera and Mark Thompson as coffee-oct", "add a note to Maria Santos: ...",
// "change Maria Santos's note to: ...", "delete Maria Santos's note", "Sam does sound, advanced", "how did yesterday's
// import go" and "import this csv: ...". Each finds its records with reads, one step after another, then proposes the
// reviewed change. A seat that may not propose is told who can make the change.
type Row = { id: string; kind: string; label: string; fields: Record<string, unknown> };
/** Every tool result since the user's last message, in order. */
function turnOutputs(prompt: Prompt): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (let i = prompt.length - 1; i >= 0 && prompt[i]!.role !== "user"; i--) {
		const m = prompt[i]!;
		if (m.role !== "tool") continue;
		const parts = m.content.flatMap((p) =>
			p.type === "tool-result" && p.output.type === "json" ? [p.output.value] : [],
		);
		out.unshift(...(parts as Record<string, unknown>[]));
	}
	return out;
}
const rowsOf = (result: Record<string, unknown> | undefined, kind?: string) =>
	((result?.rows as Row[] | undefined) ?? []).filter((r) => !kind || r.kind === kind);
const title = (text: string) => text.replace(/\b\w/g, (c) => c.toUpperCase());
const SKILL_CATEGORY: Record<string, string> = {
	sound: "tech",
	video: "tech",
	lights: "tech",
	slides: "tech",
	vocals: "worship",
	guitar: "worship",
	keys: "worship",
	drums: "worship",
	teaching: "teaching",
	hospitality: "hospitality",
};
const ORGANIZATION = {
	household:
		/\badd ([A-Z][\w'-]+(?: [A-Z][\w'-]+)?) to the ([A-Z][\w'-]+) household(?: as (head|spouse|child|other))?/i,
	move: /\bthe ([a-z'-]+?)s moved to (.+?),? update everyone\b/i,
	tag: /\btag (.+?) as ([\w-]+)\s*$/i,
	note: /\badd a note to (.+?):\s*(.+)$/is,
	editNote: /\bchange (.+?)'s note to:\s*(.+)$/is,
	deleteNote: /\bdelete (.+?)'s note\b/i,
	skill: /\b([A-Z][\w'-]+) does (\w+), (beginner|intermediate|advanced|expert)\b/i,
	receipt: /\bhow did (?:yesterday's|the|the last|our last) import go\b/i,
	import: /\bimport this csv:\s*([\s\S]+)$/i,
};
function peopleOrganizationStep(
	text: string,
	canPropose: boolean,
	canReadImports: boolean,
	outputs: Record<string, unknown>[],
) {
	const matched = Object.entries(ORGANIZATION).find(([, re]) => re.test(text));
	if (!matched) return null;
	const [kind, re] = matched;
	const m = re.exec(text)!;
	if (outputs.some((o) => typeof o.proposalId === "string"))
		return [{ type: "text" as const, text: "I prepared a review. Nothing changes until you approve it." }];
	const done = outputs.find((o) => o.error);
	if (done) return [{ type: "text" as const, text: `I could not finish that (${String(done.error)}).` }];
	const people = (search: string) => toolCall("people_read", { operation: "people.listPeople", input: { search } });
	const org = (operation: string, input: unknown) => toolCall("peopleOrganization_read", { operation, input });
	const propose = (operation: string, input: unknown) => [toolCall("propose_change", { operation, input })];
	if (kind === "receipt") {
		if (!canReadImports)
			return [{ type: "text" as const, text: "Only an Owner or Admin of this church can see how an import went." }];
		if (!outputs.length) return [org("people.getImportReceipt", {})];
		const file = rowsOf(outputs[0], "file")[0];
		if (!file) return [{ type: "text" as const, text: "I can't find an import in this church." }];
		const failed = rowsOf(outputs[0], "import").filter((r) => r.fields.status === "failed");
		const f = file.fields;
		const reasons = failed.map((r) => `row ${r.id}: ${String(r.fields.reason)}`).join("; ");
		return [
			{
				type: "text" as const,
				text: `The import on ${String(f.importedAt).slice(0, 10)}: ${String(f.created)} created, ${String(f.skipped)} skipped and ${String(f.failed)} failed.${reasons ? ` Failed rows: ${reasons}.` : ""}`,
			},
		];
	}
	if (!canPropose)
		return [
			{
				type: "text" as const,
				text: "An Owner or Admin of this church has to make that change. Your seat can't, so I didn't prepare it.",
			},
		];
	const first = (n: number, k = "person") => rowsOf(outputs[n], k)[0];
	switch (kind) {
		case "household": {
			if (outputs.length === 0) return [people(m[1]!)];
			if (outputs.length === 1) return [org("people.listHouseholds", { search: m[2]! })];
			const person = first(0),
				home = first(1, "household");
			if (!person || !home) return [{ type: "text" as const, text: "I can't find that person or household." }];
			return propose("people.addToHousehold", {
				personId: person.id,
				householdId: home.id,
				role: (m[3] ?? "other").toLowerCase(),
			});
		}
		case "move": {
			if (!outputs.length) return [org("people.listHouseholds", { search: m[1]! })];
			const home = first(0, "household");
			if (!home) return [{ type: "text" as const, text: "I can't find that household." }];
			return propose("people.propagateAddress", { householdId: home.id, address: { street: title(m[2]!.trim()) } });
		}
		case "tag": {
			const names = m[1]!.split(/,\s*|\s+and\s+/).filter(Boolean);
			if (!outputs.length) return names.map(people);
			const ids = outputs.map((o) => rowsOf(o, "person")[0]?.id).filter(Boolean);
			if (ids.length !== names.length) return [{ type: "text" as const, text: "I can't find everyone you named." }];
			return propose("people.assignTag", { personIds: ids, tagName: m[2]! });
		}
		case "note": {
			if (!outputs.length) return [people(m[1]!)];
			const person = first(0);
			return person ? propose("people.addNote", { personId: person.id, body: m[2]!.trim() }) : null;
		}
		case "editNote":
		case "deleteNote": {
			if (!outputs.length) return [people(m[1]!)];
			const person = first(0);
			if (!person) return null;
			if (outputs.length === 1) return [org("people.getActivities", { personId: person.id, kinds: ["note"] })];
			const note = rowsOf(outputs[1], "activity").find((r) => r.fields.kind === "note");
			if (!note) return [{ type: "text" as const, text: `${person.label} has no note I can change.` }];
			return kind === "editNote"
				? propose("people.editNote", { noteId: note.id, body: m[2]!.trim(), reason: "Updated in Evry" })
				: propose("people.deleteNote", { noteId: note.id, reason: "Removed in Evry" });
		}
		case "skill": {
			if (!outputs.length) return [people(m[1]!)];
			const person = first(0);
			const skill = m[2]!.toLowerCase();
			return person
				? propose("people.addSkill", {
						personId: person.id,
						name: title(skill),
						category: SKILL_CATEGORY[skill] ?? "other",
						proficiency: m[3]!.toLowerCase(),
					})
				: null;
		}
		case "import":
			return propose("people.executeBulkImport", { file: m[1]!.trim() });
	}
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
	const onboarding = onboardingStep(options, text);
	if (onboarding) return onboarding;
	const settings = settingsStep(options, text);
	if (settings) return settings;
	const hasPeople = options.tools?.some((t) => t.name === "people_read") ?? false;
	const canPropose = options.tools?.some((t) => t.name === "propose_change") ?? false;
	// A Member proposes changes to their own notifications only; the People reviews are an Owner's or Admin's.
	const canProposePeople = JSON.stringify(options.tools?.find((t) => t.name === "propose_change") ?? {}).includes(
		'"people.',
	);
	// "Change Maria's city to Austin": find the person, then propose the change for review.
	const change = /\b(?:change|set|update)\s+([A-Z][\w'-]+?)(?:'s)?\s+(city|phone|email)\s+to\s+(.+?)\.?\s*$/i.exec(
		text,
	);
	const result = lastToolOutput(options.prompt);
	const canReadMail = options.tools?.some((t) => t.name === "communication_read") ?? false;
	const canReadNotices = options.tools?.some((t) => t.name === "notifications_read") ?? false;
	const notices = notificationStep(text, { read: canReadNotices, propose: canPropose }, result);
	if (notices) return notices;
	const email = emailStep(text, canPropose, canReadMail, result);
	if (email) return email;
	if (hasPeople) {
		// The import receipt read is one of the people-organization tool's operations only for an Owner or Admin.
		const imports = JSON.stringify(options.tools?.find((t) => t.name === "peopleOrganization_read") ?? {}).includes(
			"people.getImportReceipt",
		);
		const organization = peopleOrganizationStep(text, canProposePeople, imports, turnOutputs(options.prompt));
		if (organization) return organization;
	}
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
