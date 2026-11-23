import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { counted, countWord, dayText } from "@everyfield/contracts/common";
import { captured } from "./captured.ts";

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { kind: string; id: string; label: string; fields: Record<string, unknown> };
type Output = { operation?: string; rows?: Row[]; error?: string; proposalId?: string };

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
const call = (toolName: string, input: unknown): LanguageModelV4Content[] => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify(input) },
];
const say = (text: string): LanguageModelV4Content[] => [{ type: "text", text }];
const read = (domain: string, operation: string, input: unknown) => call(`${domain}_read`, { operation, input });
const propose = (operation: string, input: unknown) => call("propose_change", { operation, input });
const rows = (o: Output | undefined) => o?.rows ?? [];
const list = (items: string[]) =>
	items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const names = (text: string) =>
	text
		.split(/\s*,\s*(?:and\s+)?|\s+and\s+/)
		.map((n) =>
			n
				.trim()
				.replace(/^the\s+/i, "")
				.replace(/^["“]|["”]$/g, ""),
		)
		.filter(Boolean);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const importedOn = (at: unknown) =>
	typeof at !== "string"
		? "an earlier date"
		: at.length === 10
			? dayText(at)
			: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
					new Date(at),
				);

const ACCEPT = /\b(?:add|accept|take) (?:all )?(?:of )?the phase(?: \d)? (?:checklists|offer)\b/i;
const DECLINE =
	/\b(?:don'?t|do not) want the phase(?: \d)? checklists\b|\bdecline the phase(?: \d)? (?:checklists|offer)\b/i;
const ANSWER = /\btake (?:only |just )?(?:the )?(.+?) checklist\b.*\bnot the others?\b/i;
const IMPORT = /\bimport the (.+?) checklist,? just (.+?)\.?$/i;
const RECEIPT = /\bimport receipt\b|\bwhat did the (?:last|latest) (?:checklist )?import\b/i;
const HANDOFF = /\bhand (my|[A-Z][\w'-]+?)(?:'s)? follow-?ups (?:over )?to (me|[A-Z][\w'-]+)/i;
const WAIT = /\bmake (?:the )?["“]?(.+?)["”]?(?: task)? wait on (.+?)\.?$/i;
const CLEAR = /\bclear (?:the )?prerequisites (?:of|on|for) (?:the )?["“]?(.+?)["”]?(?: task)?\.?$/i;

const OWNER_ONLY: Record<string, string> = {
	offer: "Only an Owner or Admin can answer the phase offer.",
	import: "Only an Owner or Admin can import a checklist.",
	handoff: "Only an Owner or Admin can hand off follow-ups.",
	prerequisites: "Only an Owner or Admin can change which tasks a task waits on.",
};
const NO_TASK_CONTEXT =
	"I can't change tasks or follow-ups in this context. Switch to a church to change its tasks. I prepared nothing.";
const REVIEWED = "I prepared a review. Nothing changes until you approve it.";

function intent(text: string) {
	if (RECEIPT.test(text)) return { kind: "receipt" as const, area: "import" };
	const answer = ANSWER.exec(text);
	if (answer)
		return { kind: "answer" as const, area: "offer", op: "tasks.answerPhaseOffer", name: captured(answer, 1) };
	if (DECLINE.test(text)) return { kind: "decline" as const, area: "offer", op: "tasks.declinePhaseOffer" };
	if (ACCEPT.test(text)) return { kind: "accept" as const, area: "offer", op: "tasks.acceptPhaseOffer" };
	const imported = IMPORT.exec(text);
	if (imported)
		return {
			kind: "import" as const,
			area: "import",
			op: "tasks.importTemplate",
			name: captured(imported, 1),
			items: names(captured(imported, 2)),
		};
	const handoff = HANDOFF.exec(text);
	if (handoff)
		return {
			kind: "handoff" as const,
			area: "handoff",
			op: "tasks.executeHandoff",
			from: captured(handoff, 1),
			to: captured(handoff, 2),
		};
	const wait = WAIT.exec(text);
	if (wait)
		return {
			kind: "prerequisites" as const,
			area: "prerequisites",
			op: "tasks.replacePrerequisites",
			target: captured(wait, 1),
			on: names(captured(wait, 2)),
		};
	const clear = CLEAR.exec(text);
	if (clear)
		return {
			kind: "prerequisites" as const,
			area: "prerequisites",
			op: "tasks.replacePrerequisites",
			target: captured(clear, 1),
			on: [],
		};
	return null;
}

function answeredBefore(out: Output[]) {
	const receipts = out.findLast((o) => o.operation === "tasks.importReceipt");
	if (!receipts) return read("tasks", "tasks.importReceipt", {});
	const catalog = out.findLast((o) => o.operation === "tasks.listTemplates");
	if (!catalog) return read("tasks", "tasks.listTemplates", {});
	const answer = rows(receipts).find((r) => r.fields.receipt === "phase offer answer");
	if (!answer) return say("No phase offer is open right now, so there's nothing to answer. I prepared nothing.");
	const checklists = rows(catalog);
	const phase = Number(checklists[0]?.fields.currentPhase);
	const nameOf = (key: string) => checklists.find((k) => k.id === key)?.label ?? key;
	const accepted = answer.label === "Phase offer declined" ? [] : answer.label.split(", ");
	const declined = checklists.filter((k) => k.fields.phase === phase && !accepted.includes(k.id)).map((k) => k.label);
	const when = dayText(answer.fields.at);
	if (!accepted.length)
		return say(
			`The phase ${phase} offer was already answered on ${when}: every checklist was declined and no task was added. I prepared nothing.`,
		);
	const created = Number(answer.fields.tasksCreated);
	return say(
		`The phase ${phase} offer was already answered on ${when}: ${list(accepted.map(nameOf))} ${countWord(accepted.length, "was", "were")} accepted (${counted(created, "task")})${declined.length ? ` and ${list(declined)} declined` : ""}. I prepared nothing.`,
	);
}

function offerStep(out: Output[], want: NonNullable<ReturnType<typeof intent>>, failed: Output | undefined) {
	if (failed?.error === "offer_answered") return answeredBefore(out);
	if (failed) return say(`I couldn't prepare that (${String(failed.error)}).`);
	const offer = out.findLast((o) => o.operation === "tasks.readPhaseOffer");
	if (!offer) return read("tasks", "tasks.readPhaseOffer", {});
	const offered = rows(offer).filter((r) => r.kind === "template");
	if (!offered.length) return answeredBefore(out);
	if (want.kind === "accept") return propose("tasks.acceptPhaseOffer", {});
	if (want.kind === "decline") return propose("tasks.declinePhaseOffer", {});
	const name = want.kind === "answer" ? want.name : "";
	const picked = offered.filter((k) => k.label.toLowerCase().includes(name.toLowerCase()));
	if (picked.length !== 1)
		return say(
			`The phase offer has no single checklist called "${name}". It offers ${list(offered.map((k) => k.label))}. Which do you want? I prepared nothing.`,
		);
	return propose("tasks.answerPhaseOffer", { accept: picked.map((k) => k.id) });
}

function importStep(out: Output[], want: { name: string; items: string[] }, failed: Output | undefined) {
	if (failed) return say(`I couldn't prepare that (${String(failed.error)}).`);
	const catalog = out.findLast((o) => o.operation === "tasks.listTemplates");
	if (!catalog) return read("tasks", "tasks.listTemplates", {});
	const checklist = rows(catalog).find((k) => same(k.label.replace(/&/g, "and"), want.name.replace(/&/g, "and")));
	if (!checklist) return say(`There's no Everyfield checklist called "${want.name}". I prepared nothing.`);
	const preview = out.findLast((o) => o.operation === "tasks.previewTemplate");
	if (!preview) return read("tasks", "tasks.previewTemplate", { checklistKey: checklist.id });
	const items = rows(preview).filter((r) => r.id.includes("/"));
	const found = want.items.map((n) => ({ n, item: items.find((i) => same(i.label, n)) }));
	const missing = found.filter((f) => !f.item).map((f) => `"${f.n}"`);
	if (missing.length)
		return say(
			`${checklist.label} has no item called ${list(missing)}. Its items are: ${items.map((i) => i.label).join("; ")}. I prepared nothing.`,
		);
	return propose("tasks.importTemplate", {
		checklistKey: checklist.id,
		itemKeys: found.map((f) => f.item?.id.split("/")[1]),
	});
}

function handoffStep(out: Output[], want: { from: string; to: string }, failed: Output | undefined) {
	const seats = out.findLast((o) => o.operation === "tasks.eligibleAssignees");
	if (!seats) return read("tasks", "tasks.eligibleAssignees", {});
	const seat = (n: string) =>
		/^(me|my)$/i.test(n)
			? rows(seats).find((r) => r.fields.you === true)
			: rows(seats).find((r) => r.label.toLowerCase().startsWith(n.toLowerCase()));
	const from = seat(want.from);
	const to = seat(want.to);
	if (!from) return say(`${want.from} has no seat in this church, so there are no follow-ups to hand off.`);
	if (!to) return say(`${want.to} has no seat in this church, so I can't hand follow-ups to them.`);
	if (!to.fields.canOwnFollowUps)
		return say(
			`${to.label} can't be assigned follow-ups, so I prepared nothing. Choose someone who can own follow-ups.`,
		);
	if (failed?.error === "protected_owner")
		return say(
			`${from.label} is an Owner of this church, and an Owner's follow-ups can't be handed off this way. I prepared nothing.`,
		);
	if (failed?.error === "not_found") return say(`${from.label} has no open follow-ups to hand off.`);
	if (failed) return say(`I couldn't prepare that (${String(failed.error)}).`);
	return propose("tasks.executeHandoff", { fromAccountId: from.id, toAccountId: to.id });
}

const ALL_STATUSES = ["not_started", "in_progress", "blocked", "complete", "no_longer_needed"];
function prerequisitesStep(out: Output[], want: { target: string; on: string[] }, failed: Output | undefined) {
	const listed = out.findLast((o) => o.operation === "tasks.list");
	if (!listed) return read("tasks", "tasks.list", { statuses: ALL_STATUSES, followUps: "exclude", limit: 100 });
	const opened = out.filter((o) => o.operation === "tasks.get");
	const known = [...rows(listed), ...opened.flatMap((o) => rows(o).slice(1))];
	const find = (n: string) => known.find((r) => same(r.label, n));
	const wanted = [want.target, ...want.on];
	if (wanted.some((n) => !find(n))) {
		const seen = new Set(opened.map((o) => rows(o)[0]?.id));
		const next = rows(listed).find((r) => r.fields.checklist && !seen.has(r.id));
		if (next) return read("tasks", "tasks.get", { taskId: next.id });
		return say(`I can't find a task called "${wanted.find((n) => !find(n))}". I prepared nothing.`);
	}
	const target = find(want.target);
	const on = want.on.map((n) => find(n));
	if (failed?.error === "dependency_cycle")
		return say(
			`${target?.label} can't wait on ${list(on.map((r) => String(r?.label)))}: that would make a cycle, because ${countWord(on.length, "it already waits", "they already wait")} on ${target?.label}, directly or through other tasks. I prepared nothing.`,
		);
	if (failed?.error === "invalid_subject") {
		const row = [target, ...on].find((r) => r?.fields.parentId);
		return say(
			row
				? `${row.label} is a checklist row of another task, and only a top-level task can wait on other tasks or be waited on. I prepared nothing.`
				: "Only a top-level task can wait on other tasks. I prepared nothing.",
		);
	}
	if (failed) return say(`I couldn't prepare that (${String(failed.error)}).`);
	return propose("tasks.replacePrerequisites", {
		taskId: target?.id,
		prerequisiteIds: on.map((r) => r?.id),
	});
}

function receiptStep(out: Output[]) {
	const receipts = out.findLast((o) => o.operation === "tasks.importReceipt");
	if (!receipts) return read("tasks", "tasks.importReceipt", {});
	const catalog = out.findLast((o) => o.operation === "tasks.listTemplates");
	if (!catalog) return read("tasks", "tasks.listTemplates", {});
	const latest = rows(receipts)[0];
	if (!latest) return say("No checklist has been imported here yet.");
	const name = latest.label
		.split(", ")
		.map((key) => rows(catalog).find((k) => k.id === key)?.label ?? key)
		.join(", ");
	const created = Number(latest.fields.tasksCreated);
	return say(
		`The latest import is ${name}, a ${String(latest.fields.receipt)} on ${importedOn(latest.fields.at)}: it created ${counted(created, "task")}.`,
	);
}

export function planStep(options: LanguageModelV4CallOptions, text: string): LanguageModelV4Content[] | null {
	const want = intent(text);
	if (!want) return null;
	const has = (name: string) => options.tools?.some((t) => t.name === name) ?? false;
	if (!has("tasks_read") && !has("followups_read")) return say(NO_TASK_CONTEXT);
	const out = turnOutputs(options.prompt);
	if (want.kind === "receipt") return has("tasks_read") ? receiptStep(out) : null;
	const proposable = JSON.stringify(options.tools?.find((t) => t.name === "propose_change") ?? {});
	if (!proposable.includes(`"${want.op}"`)) return say(`${OWNER_ONLY[want.area]} I prepared nothing.`);
	if (out.some((o) => typeof o.proposalId === "string")) return say(REVIEWED);
	const failed = out.findLast((o) => typeof o.error === "string");
	switch (want.kind) {
		case "accept":
		case "decline":
		case "answer":
			return offerStep(out, want, failed);
		case "import":
			return importStep(out, want, failed);
		case "handoff":
			return handoffStep(out, want, failed);
		case "prerequisites":
			return prerequisitesStep(out, want, failed);
	}
}
