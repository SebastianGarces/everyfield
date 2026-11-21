import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { captured, present } from "./captured.ts";

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { kind: string; id: string; label: string; fields: Record<string, unknown> };
type Output = Record<string, unknown> & { operation?: string; rows?: Row[]; total?: number | null; error?: string };

function outputs(prompt: Prompt): Output[] {
	const found: Output[] = [];
	for (let i = prompt.length - 1; i >= 0; i--) {
		const m = present(prompt[i]);
		if (m.role === "user") break;
		if (m.role !== "tool") continue;
		const parts = m.content.filter((p) => p.type === "tool-result");
		for (const p of parts.reverse())
			if (p.type === "tool-result")
				found.unshift(p.output.type === "json" ? (p.output.value as Output) : { error: p.output.type });
	}
	return found;
}
const call = (toolName: string, input: unknown): LanguageModelV4Content[] => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify(input) },
];
const say = (text: string): LanguageModelV4Content[] => [{ type: "text", text }];
const read = (domain: string, operation: string, input: unknown) => call(`${domain}_read`, { operation, input });
const propose = (operation: string, input: unknown) => call("propose_change", { operation, input });
const last = (list: Output[], operation: string) => list.findLast((o) => o.operation === operation);
const rows = (o: Output | undefined) => o?.rows ?? [];
const list = (items: string[]) =>
	items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const day = (value: unknown) => (typeof value === "string" ? value.slice(0, 10) : "no date");
const proposed = (list: Output[]) => list.findLast((o) => typeof o.proposalId === "string");
const REVIEWED = "I prepared a review. Nothing changes until you approve it.";

function nextMonday(prompt: Prompt) {
	const system = prompt.find((m) => m.role === "system");
	const at = /Current time \(trusted server clock\): (\S+?)\.\s/.exec(
		typeof system?.content === "string" ? system.content : "",
	);
	const now = new Date(at?.[1] ?? Date.now());
	const local = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
	const ahead = (8 - (local.getDay() || 7)) % 7;
	local.setDate(local.getDate() + ahead);
	return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
}

const taskLine = (r: Row) =>
	`${r.label} (${r.fields.owners ?? "nobody assigned"}, due ${r.fields.due ?? "no date"}${r.fields.overdue ? ", overdue" : ""})`;
const followUpLine = (r: Row) =>
	`${r.label} (${r.fields.owners ? `owner ${String(r.fields.owners)}` : "nobody assigned"})`;
const OUTCOME: Record<string, string> = {
	contacted: "a call where they talked",
	attempted_no_contact: "an attempted call with no conversation",
	administrative_completion: "an administrative completion, not a conversation",
	no_longer_needed: "the follow-up closed as no longer needed, not a conversation",
};

export function taskStep(
	text: string,
	prompt: Prompt,
	has: (tool: string) => boolean,
): LanguageModelV4Content[] | null {
	const out = outputs(prompt);
	const failed = out.findLast((o) => typeof o.error === "string");
	const tasks = has("tasks_read");
	const asksTasks = /\b(overdue|tasks?|remind me|focus on|checklist)\b/i.test(text);
	if (asksTasks && !tasks && !has("followups_read"))
		return say("I can't read tasks or follow-ups in this context. Switch to a church to ask about its tasks.");

	if (/\bwhat'?s overdue\b|\boverdue\b/i.test(text) && tasks) {
		const overdue = last(out, "tasks.list");
		if (!overdue) return read("tasks", "tasks.list", { due: "overdue", followUps: "exclude" });
		const owners = last(out, "tasks.listFollowUpOwners");
		if (!owners) return read("followups", "tasks.listFollowUpOwners", {});
		const t = rows(overdue);
		const f = rows(owners);
		return say(
			[
				t.length
					? `${overdue.total ?? t.length} overdue ${t.length === 1 ? "task" : "tasks"}: ${t.map(taskLine).join("; ")}.`
					: "No task is overdue.",
				f.length
					? `Separately, ${owners.total ?? f.length} open follow-ups: ${f.map(followUpLine).join("; ")}.`
					: "There are no open follow-ups.",
			].join(" "),
		);
	}

	const titled = /\btask (?:titled|called|named)\s+["“'‘]?(.+?)["”'’]?\s*$/i.exec(text);
	if (titled && tasks) {
		const found = last(out, "tasks.list");
		if (!found)
			return read("tasks", "tasks.list", {
				search: titled[1],
				statuses: ["not_started", "in_progress", "blocked", "complete", "no_longer_needed"],
			});
		const t = rows(found);
		return say(
			t.length ? `I found ${t.map(taskLine).join("; ")}.` : `No task titled "${titled[1]}" is in this church.`,
		);
	}

	const called =
		/\b(?:did anyone|has anyone|have we) (?:call|called|reach|reached|contact|contacted) (?:the )?([a-z][\w'-]+?)s?(?: yet)?\??$/i.exec(
			text,
		);
	if (called && has("followups_read")) {
		const people = last(out, "people.listPeople");
		if (!people) return read("people", "people.listPeople", { search: called[1] });
		const histories = out.filter((o) => o.operation === "followups.listContactHistory");
		const next = rows(people)[histories.length];
		if (next) return read("followups", "followups.listContactHistory", { personId: next.id });
		const lines = rows(people).map((p, i) => {
			const log = rows(histories[i]);
			if (!log.length) return `No call is recorded for ${p.label}.`;
			const latest = present(log[0]);
			return `For ${p.label}, ${String(latest.fields.recordedBy)} recorded ${OUTCOME[String(latest.fields.outcome)] ?? "an outcome"} on ${day(latest.fields.occurredAt)}${latest.fields.channel ? ` (${String(latest.fields.channel)})` : ""}.`;
		});
		if (!lines.length) return say(`I can't find anyone named ${called[1]} in this church.`);
		return say(`${lines.join(" ")} I can't read sent emails yet, so emails aren't included.`);
	}

	const who = /\bwho is following up with ([A-Z][\w'-]+)/i.exec(text);
	if (who && has("followups_read")) {
		const people = last(out, "people.listPeople");
		if (!people) return read("people", "people.listPeople", { search: who[1] });
		const person = rows(people)[0];
		if (!person) return say(`I can't find ${who[1]} in this church.`);
		const owners = last(out, "tasks.listFollowUpOwners");
		if (!owners) return read("followups", "tasks.listFollowUpOwners", { personId: person.id });
		const f = rows(owners)[0];
		if (!f) return say(`${person.label} has no open follow-up.`);
		return say(
			f.fields.owners
				? `${String(f.fields.owners)} is following up with ${person.label}.`
				: `Nobody is assigned to follow up with ${person.label} yet.`,
		);
	}

	if (/\b(first time|first-time|came|attended)\b.*\b(last night|yesterday|meeting)\b/i.test(text)) {
		if (!has("meetings_read"))
			return say(
				"I can't read meeting attendance yet, so I can't tell who came for the first time. I won't guess it from pipeline stages. The Meetings page shows attendance.",
			);
		const past = last(out, "meetings.list");
		if (!past) return read("meetings", "meetings.list", { window: "past", statuses: ["completed"], limit: 1 });
		const meeting = rows(past).find((r) => r.kind === "meeting");
		if (!meeting) return say("I can't find a held meeting in Meetings.");
		const attendance = last(out, "meetings.listAttendance");
		if (!attendance) return read("meetings", "meetings.listAttendance", { meetingId: meeting.id });
		const firstTime = rows(attendance).filter((r) => r.kind === "person" && r.fields.visit === "first time");
		if (!firstTime.length) return say(`No first-time guest is recorded at ${meeting.label}.`);
		const open = last(out, "followups.readObligations");
		if (!open)
			return read("followups", "followups.readObligations", { meetingId: meeting.id, state: "open", limit: 100 });
		const firsts = new Set(firstTime.map((r) => r.id));
		const needs = rows(open).filter((r) => firsts.has(String(r.fields.personId)));
		return say(
			[
				`${firstTime.length} first-time ${firstTime.length === 1 ? "guest is" : "guests are"} recorded at ${meeting.label}.`,
				needs.length
					? `${needs.length === 1 ? "One still needs" : `${needs.length} still need`} a follow-up: ${needs.map(followUpLine).join("; ")}.`
					: "None of them has an open follow-up.",
			].join(" "),
		);
	}

	const logged = /\blog that i (called|texted|emailed|visited|met) ([a-z][\w'-]+)(?: today)?,?\s*(.*)$/i.exec(text);
	if (logged && has("followups_read") && has("propose_change")) {
		const done = proposed(out);
		if (done) return say(REVIEWED);
		const people = last(out, "people.listPeople");
		if (!people) return read("people", "people.listPeople", { search: logged[2] });
		const person = rows(people)[0];
		if (!person) return say(`I can't find ${logged[2]} in this church.`);
		const owners = last(out, "tasks.listFollowUpOwners");
		if (!owners) return read("followups", "tasks.listFollowUpOwners", { personId: person.id });
		const duty = rows(owners)[0];
		const note = captured(logged, 3).trim();
		const channel = { called: "phone", texted: "text", emailed: "email", visited: "in_person", met: "in_person" }[
			captured(logged, 1).toLowerCase()
		];
		return propose("followups.recordOutcome", {
			...(duty ? { taskId: duty.id } : { personId: person.id, completeTask: false }),
			outcome: "contacted",
			occurred: "now",
			channel,
			...(note ? { notes: note.charAt(0).toUpperCase() + note.slice(1).replace(/\.?$/, ".") } : {}),
		});
	}

	const split = /\bsplit the (\d+) new guests between ([A-Z][\w'-]+) and ([A-Z][\w'-]+)/i.exec(text);
	if (split && tasks) {
		const seats = last(out, "tasks.eligibleAssignees");
		if (!seats) return read("tasks", "tasks.eligibleAssignees", {});
		const named = [captured(split, 2), captured(split, 3)].map((n) => ({
			n,
			seat: rows(seats).find((r) => r.label.toLowerCase().startsWith(n.toLowerCase())),
		}));
		const cannot = named.filter((x) => !x.seat?.fields.canOwnFollowUps);
		if (cannot.length)
			return say(
				`${list(cannot.map((x) => x.seat?.label ?? x.n))} can't be assigned follow-ups. ${list(named.filter((x) => !cannot.includes(x)).map((x) => present(x.seat).label))} can. What would you like to do: give all ${split[1]} to them, or choose someone else?`,
			);
	}
	const all = /\bgive (?:them|all of them|all \w+) (?:all )?to ([A-Z][\w'-]+)/i.exec(text);
	if (all && tasks && has("propose_change")) {
		if (proposed(out)) return say(REVIEWED);
		if (failed) return say(`I couldn't prepare that (${String(failed.error)}).`);
		const open = last(out, "tasks.listFollowUpOwners");
		if (!open) return read("followups", "tasks.listFollowUpOwners", { owner: "needs_owner" });
		const seats = last(out, "tasks.eligibleAssignees");
		if (!seats) return read("tasks", "tasks.eligibleAssignees", {});
		const seat = rows(seats).find((r) => r.label.toLowerCase().startsWith(captured(all, 1).toLowerCase()));
		if (!seat?.fields.canOwnFollowUps) return say(`${all[1]} can't be assigned follow-ups.`);
		return propose("tasks.assignFollowUp", {
			items: rows(open).map((d) => ({ taskId: d.id, assigneeIds: [seat.id] })),
		});
	}

	const remind = /\bremind me every (monday|week) to (.+?)\.?$/i.exec(text);
	if (remind && has("propose_change")) {
		if (proposed(out)) return say(REVIEWED);
		if (failed) return say(`I couldn't prepare that (${String(failed.error)}).`);
		const title = captured(remind, 2).charAt(0).toUpperCase() + captured(remind, 2).slice(1);
		return propose("tasks.create", {
			title,
			due: nextMonday(prompt),
			assigneeIds: ["me"],
			recurrence: { frequency: "weekly" },
		});
	}

	if (/\bfocus on\b/i.test(text) && tasks) {
		const due = last(out, "tasks.list");
		if (!due) return read("tasks", "tasks.list", { due: "this_week", followUps: "exclude" });
		const owners = last(out, "tasks.listFollowUpOwners");
		if (!owners) return read("followups", "tasks.listFollowUpOwners", {});
		const meetings = has("meetings_read") ? last(out, "meetings.list") : undefined;
		if (has("meetings_read") && !meetings) return read("meetings", "meetings.list", { window: "upcoming", limit: 10 });
		const board = last(out, "people.getPipelineData");
		if (!board && has("peopleOrganization_read")) return read("peopleOrganization", "people.getPipelineData", {});
		const flagged = rows(board).filter((r) => r.fields.inactivity === "alert" || r.fields.inactivity === "warning");
		return say(
			[
				`From Tasks, due this week or overdue: ${rows(due).map(taskLine).join("; ") || "nothing"}.`,
				`From Follow-ups, open: ${rows(owners).map(followUpLine).join("; ") || "none"}.`,
				board
					? `From the pipeline, people flagged for inactivity: ${flagged.map((r) => `${r.label} (${String(r.fields.inactivity)})`).join("; ") || "none"}.`
					: "",
				meetings
					? `From Meetings, upcoming: ${
							rows(meetings)
								.filter((r) => r.kind === "meeting")
								.map((r) => `${r.label} (${String(r.fields.when ?? "no time")})`)
								.join("; ") || "none"
						}.`
					: "I couldn't read meetings or your calendar: those aren't available to me yet.",
			]
				.filter(Boolean)
				.join("\n\n"),
		);
	}

	if (/\bdue today\b/i.test(text) && tasks) {
		const due = last(out, "tasks.list");
		if (!due) return read("tasks", "tasks.list", { due: "today", mine: /\b(me|my|mine)\b/i.test(text) });
		const t = rows(due);
		return say(t.length ? `Due today or overdue: ${t.map(taskLine).join("; ")}.` : "Nothing is due today.");
	}

	const complete =
		/^(?:please )?(?:complete|mark)\s+(?:the\s+)?["“]?(.+?)["”]?(?:\s+task)?(?:\s+as)?(?:\s+(?:done|complete))?\.?$/i.exec(
			text,
		);
	if (complete && tasks && has("propose_change") && !/\bchecklist\b/i.test(text)) {
		if (proposed(out)) return say(REVIEWED);
		if (failed)
			return say(
				failed.error === "not_assigned"
					? "You can only complete tasks assigned to you. This one is assigned to someone else."
					: `I couldn't prepare that (${String(failed.error)}).`,
			);
		const found = last(out, "tasks.list");
		if (!found) return read("tasks", "tasks.list", { search: complete[1] });
		const task = rows(found)[0];
		if (!task) return say(`I can't find a task called "${complete[1]}".`);
		return propose("tasks.complete", { taskId: task.id });
	}

	const assign = /^assign (?:the )?["“]?(.+?)["”]?(?: task)? to ([A-Z][\w'-]+(?: [A-Z][\w'-]+)?)\.?$/i.exec(text);
	if (assign && tasks && has("propose_change")) {
		if (proposed(out)) return say(REVIEWED);
		if (failed) return say(`I couldn't prepare that (${String(failed.error)}).`);
		const found = last(out, "tasks.list");
		if (!found) return read("tasks", "tasks.list", { search: assign[1] });
		const task = rows(found)[0];
		if (!task) return say(`I can't find a task called "${assign[1]}".`);
		const seats = last(out, "tasks.eligibleAssignees");
		if (!seats) return read("tasks", "tasks.eligibleAssignees", {});
		const name = captured(assign, 2).toLowerCase();
		const seat = rows(seats).find((r) => r.label.toLowerCase().startsWith(name));
		if (!seat)
			return say(
				`${assign[2]} has no seat in this church that can hold tasks, so I can't assign "${task.label}" to them. Invite them to the church first.`,
			);
		return propose("tasks.edit", { taskId: task.id, patch: { assigneeIds: [seat.id] } });
	}

	const checklist =
		/\badd ["“]?(.+?)["”]? to the (.+?) checklist(?: and (?:tick|check) off ["“]?(.+?)["”]?)?\.?$/i.exec(text);
	if (checklist && tasks && has("propose_change")) {
		if (proposed(out)) return say(REVIEWED);
		if (failed) return say(`I couldn't prepare that (${String(failed.error)}).`);
		const found = last(out, "tasks.list");
		if (!found) return read("tasks", "tasks.list", { search: checklist[2] });
		const parent = rows(found)[0];
		if (!parent) return say(`I can't find a task called "${checklist[2]}".`);
		const detail = last(out, "tasks.get");
		if (!detail) return read("tasks", "tasks.get", { taskId: parent.id });
		const tick = checklist[3]
			? rows(detail).find(
					(r) => r.fields.parentId === parent.id && r.label.toLowerCase() === captured(checklist, 3).toLowerCase(),
				)
			: undefined;
		return propose("tasks.createSubtask", {
			parentId: parent.id,
			add: [checklist[1]],
			...(tick ? { tick: [{ taskId: tick.id, complete: true }] } : {}),
		});
	}
	return null;
}

export const TASK_DATA = /\btask (?:titled|called|named)\b/i;
