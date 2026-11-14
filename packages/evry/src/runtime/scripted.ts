import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4Content,
	LanguageModelV4GenerateResult,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { onboardingStep } from "./scripted-onboarding.ts";
import { pipelineStep } from "./scripted-pipeline.ts";
import { TASK_DATA, taskStep } from "./scripted-tasks.ts";
import { assessmentStep } from "./scripted-assessments.ts";
import { mailStep, proposesOn } from "./scripted-mail.ts";
import { MEMBER_PHASES } from "../catalog/catalog.ts";
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
	// Reporting what the church started is a signal to record, not a request for prayer.
	if (SIGNAL.test(text)) return "application";
	// A task titled "Pray for the launch" is task data, not a request for prayer.
	if (!TASK_DATA.test(text) && /\b(pray|prayer|biblical|scripture|spiritual(ly)?|pastoral(ly)?|suitab)/i.test(text))
		return "pastoral_boundary";
	// A judgment of a person ("do you think Daniel is qualified?") is a human call, never Evry's.
	if (/\b(do you think|would you say|in your opinion)\b.*\b(qualified|ready|mature|called)\b/i.test(text))
		return "pastoral_boundary";
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
		const people = new Map(
			rows.filter((r) => r.kind === "person").map((r) => [(r as unknown as { id: string }).id, r.label]),
		);
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
		return [
			toolCall("peopleOrganization_read", { operation: "people.previewImport", input: { attachmentId: newest.id } }),
		];
	if (typeof result?.proposalId === "string")
		return say("I prepared the import for your review. People stays as it is until you approve it.");
	if (result) return null;
	if (importing && canPropose && newest) {
		const digest = files.find((f) => f.name.toLowerCase() === newest.name.toLowerCase() && f.checked)?.checked;
		if (!digest)
			return [
				toolCall("peopleOrganization_read", { operation: "people.previewImport", input: { attachmentId: newest.id } }),
			];
		return [
			toolCall("propose_change", {
				operation: "people.executeBulkImport",
				input: { attachmentId: newest.id, fileDigest: digest },
			}),
		];
	}
	return [
		toolCall("peopleOrganization_read", { operation: "people.previewImport", input: { attachmentId: newest!.id } }),
	];
}

// Dates (WP-085): "Nov 1 at 1:30am" is checked against the church's calendar before anything uses it.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function dateStep(text: string, result: Record<string, unknown> | null, canRead: boolean) {
	const say = (t: string) => [{ type: "text" as const, text: t }];
	if (/\bthe \d{1,2}(st|nd|rd|th)\b|-ish\b/i.test(text) && !result)
		return say("Which date do you mean? Tell me the month and day, and I'll check it against the church's calendar.");
	const m =
		/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:,? (\d{4}))? at (\d{1,2}):(\d{2})\s*(am|pm)\b/i.exec(
			text,
		);
	if (!m || !canRead) return null;
	if (!result) {
		const year = m[3] ?? String(new Date().getUTCFullYear());
		const h = (Number(m[4]) % 12) + (/^p/i.test(m[6]!) ? 12 : 0);
		const date = `${year}-${String(MONTHS.indexOf(m[1]!.toLowerCase().slice(0, 3)) + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
		return [
			toolCall("calendar_read", {
				operation: "calendar.resolve",
				input: { date, time: `${String(h).padStart(2, "0")}:${m[5]}` },
			}),
		];
	}
	const fields = (result.rows as { fields: Record<string, string> }[] | undefined)?.[0]?.fields;
	if (!fields) return null;
	if (fields.status === "ambiguous")
		return say(
			`That time happens twice that day as the clocks fall back. Do you mean ${fields.option1} (the first) or ${fields.option2} (the second)?`,
		);
	if (fields.status === "nonexistent")
		return say(
			`That time doesn't exist that day in ${fields.zone}: the clocks skip it. What time would you like instead?`,
		);
	if (fields.status === "exact") return say(`That is ${fields.shows}.`);
	return say("That isn't a real date. Which date do you mean?");
}

// Honest limits (EVR-007, META-01, SAF-02, SAF-06, SAF-16, SAF-17) and saved outcomes (GAP-EVR-429).
function limitStep(text: string, system: string, result: Record<string, unknown> | null, canPropose: boolean) {
	const say = (t: string) => [{ type: "text" as const, text: t }];
	if (/background check/i.test(text))
		return say("Everyfield doesn't track background checks, so I have nothing to look up for that.");
	if (/\bdid you send\b|\bwas it sent\b/i.test(text)) {
		const lines = [...system.matchAll(/^- (communication\.\w+) for "([^"]+)" \(proposalId [^)]+\): (.+)$/gm)].map(
			([, op, subject, state]) =>
				`- "${subject}": ${/^waiting/.test(state!) ? "not sent, waiting for your review" : /sent to the email service/.test(state!) ? (/delivery not confirmed/.test(state!) ? "sent, delivery not confirmed yet" : "sent and delivered") : state}${op === "communication.saveDraft" ? " (draft)" : ""}`,
		);
		return say(lines.length ? lines.join("\n") : "Nothing was sent from this conversation.");
	}
	// A person's own notifications and digest are always theirs: the notification step answers those.
	if (
		!canPropose &&
		/\b(move|change|set|update|delete|remove|add)\b/i.test(text) &&
		!/\b(notifications?|digest)\b/i.test(text) &&
		/Only an Owner or Admin/.test(system)
	)
		return say("An Owner or Admin of this church has to make that change. I can't prepare it for you.");
	const bulk = /\b(delete|remove) (everyone|everybody|all) in (\w+)/i.exec(text);
	if (bulk && canPropose) {
		if (!result)
			return [
				toolCall("people_read", {
					operation: "people.listPeople",
					input: { stages: [bulk[3]!.toLowerCase()], limit: 1 },
				}),
			];
		if (result.operation === "people.listPeople")
			return say(
				`That would remove all ${String(result.total)} people in ${bulk[3]}. Do you want me to prepare those removals? Tell me to go ahead, or name who to keep.`,
			);
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
		return [
			toolCall("peopleOrganization_read", {
				operation: "people.getActivities",
				input: { personId: rows[0]!.id, page, limit: 10 },
			}),
		];
	}
	if (result.operation !== "people.getActivities") return null;
	const rows = (result.rows as { label: string; fields: Record<string, string | null> }[]) ?? [];
	const lines = rows.map(
		(r) => `- ${String(r.fields.occurredAt).slice(0, 10)}: ${r.label}${r.fields.to ? ` (to ${r.fields.to})` : ""}`,
	);
	const more =
		typeof result.next === "number" ? `\nThere is more. Ask for page ${result.next} of ${m[1]}'s history.` : "";
	return [
		{
			type: "text" as const,
			text: `${m[1]}'s history, page ${result.page}:\n${lines.join("\n") || "- nothing recorded"}${more}`,
		},
	];
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

// Wiki requests (DOC-03, WIKI-008): "what does the wiki say about running a vision meeting", "what should I read next?",
// "where did I leave off?", and on an open article "bookmark this", "this article was helpful" and "a PDF of this
// article". The answer quotes only what a Wiki read returned, with its title and link; no match says so. A request to
// edit the Wiki is pointed to Church Documents. Article text is never read as an instruction.
const WIKI_ASK = /\bwhat does the wiki say about\s+(.+?)[?.!\s]*$/i;
const WIKI_NEXT = /\bwhat should i read next\b/i;
const WIKI_RESUME = /\bwhere did i leave off\b/i;
const WIKI_BOOKMARK = /\bbookmark (?:this|it)\b/i;
const WIKI_VOTE = /\b(?:this|the) article (?:was|is) (not helpful|unhelpful|helpful)\b/i;
const WIKI_PDF = /\bpdf\b/i;
const WIKI_EDIT = /\b(?:edit|rewrite|change)\b.*\b(?:wiki|article)\b|\badd\b.*\bto the wiki\b/i;
const WIKI_EDIT_ANSWER =
	"I can't edit the Wiki. It is shared reading, and churches keep their own writing in Church Documents.";
const VERIFIED = "Verified references on the user's page: ";
type WikiRow = { kind: string; id: string; label: string; fields: Record<string, unknown> };
/** The open article the page reference names, read again under current authority (resolveReferences). */
function pageArticle(prompt: Prompt): string | null {
	const system = prompt.find((m) => m.role === "system")?.content;
	const at = typeof system === "string" ? system.indexOf(VERIFIED) : -1;
	if (at < 0) return null;
	const line = system!.slice(at + VERIFIED.length).split("\n")[0]!;
	const refs = JSON.parse(line) as { kind: string; id: string }[];
	return refs.find((r) => r.kind === "article")?.id ?? null;
}
const linked = (row: WikiRow) => `[${row.label}](${String(row.fields.href)})`;
function wikiStep(
	text: string,
	options: LanguageModelV4CallOptions,
	result: Record<string, unknown> | null,
): LanguageModelV4Content[] | null {
	if (!options.tools?.some((t) => t.name === "wiki_read")) return null;
	// Only a Wiki request: another tool's result or error in the same turn is not the Wiki's.
	if (![WIKI_ASK, WIKI_NEXT, WIKI_RESUME, WIKI_BOOKMARK, WIKI_VOTE, WIKI_PDF, WIKI_EDIT].some((ask) => ask.test(text)))
		return null;
	const read = (operation: string, input: unknown) => [toolCall("wiki_read", { operation, input })];
	const say = (answer: string) => [{ type: "text" as const, text: answer }];
	const rows = (result?.rows as WikiRow[] | undefined) ?? [];
	if (WIKI_EDIT.test(text) && !WIKI_ASK.test(text)) return say(WIKI_EDIT_ANSWER);
	if (result && typeof result.proposalId === "string" && rows[0]?.kind === "article")
		return say(`I prepared a review for ${rows[0].label}. Nothing changes until you approve it.`);
	if (result?.error) return say(`I could not read the Wiki (${String(result.error)}).`);
	const ask = WIKI_ASK.exec(text);
	if (ask) {
		const topic = ask[1]!;
		if (!result) return read("wiki.search", { query: topic });
		if (result.operation === "wiki.search")
			return rows[0]
				? read("wiki.referenceExcerpt", { articleId: rows[0].fields.articleId })
				: say(`The Wiki has nothing on ${topic}.`);
		const [row] = rows;
		if (!row) return say(`The Wiki has nothing on ${topic}.`);
		const whose = row.fields.source === "global" ? "" : ` This is your ${String(row.fields.source)}'s version.`;
		// The excerpt itself is quoted word for word on the result card above the answer.
		return say(`Here is what the Wiki's article ${linked(row)} says, quoted above.${whose}`);
	}
	if (WIKI_NEXT.test(text)) {
		if (!result) return read("wiki.recommendForPhase", {});
		if (!rows.length) return say("The Wiki has no suggestions for your phase.");
		const phase = rows[0]!.fields.phase ? ` for ${String(rows[0]!.fields.phase)}` : "";
		return say(`The Wiki suggests these${phase}:\n\n${rows.map((r) => `- ${linked(r)}`).join("\n")}`);
	}
	if (WIKI_RESUME.test(text)) {
		if (!result) return read("wiki.reading.resume", {});
		const [row] = rows;
		return say(
			row
				? `You were last reading ${linked(row)} (${String(row.fields.read)} read).`
				: "You haven't opened a Wiki article yet.",
		);
	}
	const vote = WIKI_VOTE.exec(text);
	if (WIKI_BOOKMARK.test(text) || vote || WIKI_PDF.test(text)) {
		const articleId = pageArticle(options.prompt);
		if (!articleId) return say("Open the article on the Wiki page, then ask me again.");
		if (WIKI_PDF.test(text)) {
			if (!result) return read("wiki.article.exportPdf", { articleId });
			const [row] = rows;
			if (!row) return say("I can't find that article in your Wiki.");
			return say(
				`Here is the Wiki's PDF of ${linked(row)}: [Download the PDF](${String(row.fields.pdfHref)}). Nothing is saved.`,
			);
		}
		if (result) return say("I could not prepare that review.");
		return [
			toolCall("propose_change", {
				operation: vote ? "wiki.feedback.setMine" : "wiki.bookmarks.set",
				input: vote ? { articleId, vote: vote[1] === "helpful" ? "helpful" : "unhelpful" } : { articleId },
			}),
		];
	}
	return null;
}

// Phase and signal requests (adapters/intelligence): "what phase are we in", "what do we need to move to the next
// phase?", "move us to Launch Team Formation", "move us back to Discovery", "we started prayer and fasting this week",
// "correct our core group giving signal: ...", "our core group is still giving". Reads first where a review needs a
// phase number; every change is only proposed.
const PHASE_NOW = /\bwhat phase are we in\b/i;
const NEXT_PHASE = /\bmove to the next phase\b/i;
const MOVE = /\bmove us (?:back )?to ([A-Za-z &-]+?)\.?$/i;
const SIGNAL = /\bwe started prayer and fasting\b/i;
const CORRECT_GIVING = /\bcorrect our core group giving\b/i;
const STILL_GIVING = /\bcore group is still giving\b/i;
const PHASE_ASKS = [PHASE_NOW, NEXT_PHASE, MOVE, SIGNAL, CORRECT_GIVING, STILL_GIVING];
const longDay = (date: unknown) =>
	typeof date === "string"
		? new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
				month: "long",
				day: "numeric",
				year: "numeric",
				timeZone: "UTC",
			})
		: "an unknown day";
function phaseStep(
	text: string,
	options: LanguageModelV4CallOptions,
	result: Record<string, unknown> | null,
): LanguageModelV4Content[] | null {
	if (!PHASE_ASKS.some((ask) => ask.test(text))) return null;
	const has = (name: string) => options.tools?.some((t) => t.name === name) ?? false;
	if (!has("phases_read")) return [{ type: "text", text: MEMBER_PHASES }];
	const read = (operation: string, input: unknown = {}) => [toolCall("phases_read", { operation, input })];
	const propose = (operation: string, input: unknown) => [toolCall("propose_change", { operation, input })];
	if (result && typeof result.proposalId === "string")
		return [{ type: "text", text: "I prepared a review. Nothing changes until you approve it." }];
	const rows = (result?.rows as { id: string; label: string; fields: Record<string, unknown> }[] | undefined) ?? [];
	if (PHASE_NOW.test(text)) {
		if (!result) return read("phases.readHistory");
		const current = rows.find((r) => r.id === "current");
		return [{ type: "text", text: `You're in ${current?.label}, since ${longDay(current?.fields.since)}.` }];
	}
	if (NEXT_PHASE.test(text)) {
		if (!result) return read("phases.readReadiness");
		const head = rows.find((r) => r.id !== "current" && !("status" in r.fields));
		const criteria = rows.filter((r) => "status" in r.fields).map((r) => `- ${r.label}: ${String(r.fields.status)}`);
		return [
			{
				type: "text",
				text: [
					`To leave ${head?.label} for ${String(head?.fields.next)}, these are the exit criteria:`,
					...criteria,
					"",
					"Moving is your call.",
				].join("\n"),
			},
		];
	}
	const move = MOVE.exec(text);
	if (move) {
		if (!result) return read("phases.readCatalog");
		const to = rows.find((r) => r.label.toLowerCase() === move[1]!.trim().toLowerCase());
		if (!to) return [{ type: "text", text: `I can't find a phase called ${move[1]}.` }];
		return propose("phases.transition", { toPhase: Number(to.id), reason: text });
	}
	if (!has("propose_change")) return null;
	const today = new Date().toISOString().slice(0, 10);
	if (SIGNAL.test(text))
		return propose("signals.attest", { key: "prayer_rhythm_established", value: "yes", asOf: today, detail: text });
	if (CORRECT_GIVING.test(text))
		return propose("signals.correct", {
			action: "correct",
			key: "core_group_giving",
			value: "not_yet",
			asOf: today,
			detail: text.replace(/^.*?:\s*/, ""),
		});
	return propose("signals.reaffirm", { key: "core_group_giving" });
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
	tools: { read: boolean; propose: boolean; oversight: boolean },
	result: Record<string, unknown> | null,
): LanguageModelV4Content[] | null {
	const missed = /\b(missed|unread notifications|what('|’)?s new)\b/i.test(text);
	const those = /\bmark (?:those|these|the) (\w+) (?:as )?read\b/i.exec(text);
	const all = /\bmark (?:all|everything)(?: (?:of them|notifications))? (?:as )?read\b/i.test(text);
	const email = /\bstop emailing me(?: about)? task reminders\b/i.test(text);
	const cadence = /\bsend my (?:oversight )?digest (daily|weekly)\b/i.exec(text);
	const other =
		/\bdigest\b.*\b(every \d+ hours?|hourly|monthly|twice a \w+|(?:mon|tues|wednes|thurs|fri|satur|sun)days?|at noon)\b/i.test(
			text,
		);
	const preview = /\bnext (?:oversight )?digest\b/i.test(text);
	const someone =
		/\b(?:[Cc]hange|[Tt]urn off|[Ss]top)\b.*\b([A-Z][a-z]+)'s (?:notifications?|(?:oversight )?digest)\b/.exec(text);
	// In an organization, the digest is the oversight digest.
	const digest = tools.oversight ? "oversight digest" : "church digest";
	if (!(missed || those || all || email || cadence || other || preview || someone)) return null;
	const propose = (operation: string, input: unknown) => [toolCall("propose_change", { operation, input })];
	const read = (operation: string, input: unknown) => [toolCall("notifications_read", { operation, input })];
	if (someone)
		return [
			{
				type: "text",
				text: `Each person sets their own notifications and digest, so I can't change ${someone[1]}'s. I can change yours.`,
			},
		];
	if (other)
		return [
			{
				type: "text",
				text: `Your ${digest} can come daily or weekly. Those are the only choices Settings offers.`,
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
		return propose(tools.oversight ? "notifications.oversightDigestCadence.set" : "notifications.digestCadence.set", {
			cadence: cadence[1]!.toLowerCase(),
		});
	if (!tools.read) return null;
	if (preview) {
		if (!result)
			return read(tools.oversight ? "notifications.previewOversightDigest" : "notifications.previewPlanterDigest", {});
		const [head, ...lines] = (result.rows as { label: string; fields: Record<string, unknown> }[] | undefined) ?? [];
		if (!head)
			return [
				{
					type: "text",
					text: tools.oversight
						? "No oversight digest is owed yet."
						: "Your church digest is turned off, so no digest is coming.",
				},
			];
		if (head.fields.sent === false)
			return [
				{
					type: "text",
					text: `Your next ${digest} would not be sent: no linked plant shared activity from ${String(head.fields.from)} to ${String(head.fields.to)}, and an empty digest sends nothing.`,
				},
			];
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
}

// Meetings requests (WP-065/066), each through the same tools a model uses: read the meetings, then answer from the rows
// or propose the reviewed change. "what are my upcoming meetings?", "who rsvp'd for thursday's vision night",
// "print the agenda for sunday", "what do I still need from the vision kit?", "are vision nights growing? last 3",
// "set up a vision meeting next thursday 7pm at the coffee shop" (then "the 22nd"), "add a walk-in, Luis, no last name",
// "mark Maria, Alex and Casey as attended and finalize it", "score last night's vision meeting for me" (then the eight
// scores) and "delete the <meeting>".
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
const SET_UP = /\bset up a vision meeting next thursday (\d{1,2})\s*(am|pm) at the (.+?)\.?$/i;

function meetingsStep(
	text: string,
	prompt: Prompt,
	tools: LanguageModelV4CallOptions["tools"],
): LanguageModelV4Content[] | null {
	const canRead = tools?.some((t) => t.name === "meetings_read") ?? false;
	if (!canRead) return null;
	const proposeTool = tools?.find((t) => t.name === "propose_change");
	const can = (op: string) => !!proposeTool && JSON.stringify(proposeTool).includes(op);
	const earlierTexts = earlierUserTexts(prompt);
	const earlier = earlierTexts.join("\n");
	const pickedDay = /^(?:the )?(\d{1,2})(?:st|nd|rd|th)?\.?$|\bthursday,? (\w+ \d{1,2})\b/i.exec(text.trim());
	// The latest earlier request to set one up, so a reply such as "the 19th" answers the question just asked.
	const asked =
		earlierTexts
			.reverse()
			.map((t) => SET_UP.exec(t))
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
	const setUp = SET_UP.exec(text);
	if (setUp || (pickedDay && asked)) {
		const [, hour, ampm, place] = (setUp ?? asked)!;
		if (!outputs.length) return read("venues.list", { search: place!.split(" ")[0] });
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
	const pipeline = pipelineStep(options, text);
	if (pipeline) return pipeline;
	const onboarding = onboardingStep(options, text);
	if (onboarding) return onboarding;
	const settings = settingsStep(options, text);
	if (settings) return settings;
	const hasPeople = options.tools?.some((t) => t.name === "people_read") ?? false;
	const canPropose = options.tools?.some((t) => t.name === "propose_change") ?? false;
	// A Member proposes changes to their own notifications only; the People reviews are an Owner's or Admin's.
	const canProposePeople = proposesOn(options, "people");
	// "Change Maria's city to Austin": find the person, then propose the change for review.
	const change = /\b(?:change|set|update)\s+([A-Z][\w'-]+?)(?:'s)?\s+(city|phone|email)\s+to\s+(.+?)\.?\s*$/i.exec(
		text,
	);
	const has = (name: string) => options.tools?.some((t) => t.name === name) ?? false;
	const task = taskStep(text, options.prompt, has);
	if (task) return task;
	const result = lastToolOutput(options.prompt);
	const system = systemText(options.prompt);
	const canReadMail = options.tools?.some((t) => t.name === "communication_read") ?? false;
	const records = options.tools?.some((t) => t.name === "peopleAssessments_read") ?? false;
	const assessed = assessmentStep(text, options.prompt, records, toolCall);
	if (assessed) return assessed;
	const steps =
		limitStep(text, system, result, canProposePeople) ??
		fileStep(text, system, result, canProposePeople) ??
		dateStep(text, result, options.tools?.some((t) => t.name === "calendar_read") ?? false) ??
		historyStep(text, result);
	if (steps) return steps;
	const mail = mailStep(options);
	if (mail) return mail;
	const wiki = wikiStep(text, options, result);
	if (wiki) return wiki;
	const canReadNotices = options.tools?.some((t) => t.name === "notifications_read") ?? false;
	const oversight = JSON.stringify(options.tools?.find((t) => t.name === "notifications_read") ?? {}).includes(
		"notifications.previewOversightDigest",
	);
	const notices = notificationStep(text, { read: canReadNotices, propose: canPropose, oversight }, result);
	if (notices) return notices;
	const email = emailStep(text, proposesOn(options, "communication"), canReadMail, result);
	if (email) return email;
	const phase = phaseStep(text, options, result);
	if (phase) return phase;
	if (hasPeople) {
		// The import receipt read is one of the people-organization tool's operations only for an Owner or Admin.
		const imports = JSON.stringify(options.tools?.find((t) => t.name === "peopleOrganization_read") ?? {}).includes(
			"people.getImportReceipt",
		);
		const organization = peopleOrganizationStep(text, canProposePeople, imports, turnOutputs(options.prompt));
		if (organization) return organization;
	}
	const meetings = meetingsStep(text, options.prompt, options.tools);
	if (meetings) return meetings;
	if (result && typeof result.proposalId === "string" && (DRAFT.test(text) || EMAIL_REVIEW.test(text)))
		return [{ type: "text", text: "I prepared a review. Nothing is saved or sent until you approve it." }];
	if (result) {
		if (result.error === "already_applied")
			return [
				{ type: "text", text: "That change was already applied in this conversation, so I didn't prepare it again." },
			];
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
