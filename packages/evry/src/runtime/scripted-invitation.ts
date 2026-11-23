import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { addDays, weekdayOf } from "@everyfield/contracts/common";
import { randomUUID } from "node:crypto";
import { captured } from "./captured.ts";

type Prompt = LanguageModelV4CallOptions["prompt"];
type Row = { kind: string; id: string; label: string; fields: Record<string, unknown> };
type Change = { field: string; after: unknown };
type Output = Record<string, unknown> & { rows?: Row[]; error?: string; proposalId?: string; changes?: Change[] };

const call = (toolName: string, input: unknown): LanguageModelV4Content[] => [
	{ type: "tool-call", toolCallId: randomUUID(), toolName, input: JSON.stringify(input) },
];
const say = (...lines: string[]): LanguageModelV4Content[] => [{ type: "text", text: lines.join("\n") }];

const INVITE =
	/\binvite (?:the )?(?:([a-z][\w'-]*?) (?:family|household)|(core group|launch team|leaders|prospects)) to the next vision (?:meeting|night)\b/i;
const SET_UP =
	/\bset up a vision (?:meeting|night) (sunday|monday|tuesday|wednesday|thursday|friday|saturday) at (?:the )?(.+?) and invite the (core group|launch team|leaders|prospects)\b/i;
const REUSE = /\b(?:do|send) the same invit(?:e|ation) for this month'?s vision (?:night|meeting)\b/i;
const PLAN = /\bplan (?:the )?follow-?up after (?:the )?vision (?:night|meeting)\b/i;
const FOLLOW = /\bcreate a follow-?up with ([A-Z][\w'-]+(?: [A-Z][\w'-]+)?)\.?\s*$/i;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const GROUP: Record<string, string> = {
	"core group": "core_group",
	"launch team": "launch_team",
	leaders: "leaders",
	prospects: "prospects",
};
const OWNER_ONLY = "An Owner or Admin has to make that change. Your seat can't, so I didn't prepare it.";

const lastUser = (prompt: Prompt) => prompt.findLastIndex((m) => m.role === "user");
const textOf = (m: Prompt[number]) =>
	m.role === "user" ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ") : "";
function turnOutputs(prompt: Prompt): Output[] {
	return prompt
		.slice(lastUser(prompt) + 1)
		.flatMap((m) =>
			m.role === "tool"
				? m.content.flatMap((p) =>
						p.type === "tool-result" && p.output.type === "json" ? [p.output.value as Output] : [],
					)
				: [],
		);
}
const rowsOf = (o: Output | undefined, kind: string) => (o?.rows ?? []).filter((r) => r.kind === kind);
function churchToday(prompt: Prompt) {
	const system = prompt.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n");
	const clock = /Current time \(trusted server clock\): (\S+?)\.?(?:\s|$)/.exec(system)?.[1];
	return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(clock ? new Date(clock) : new Date());
}
function nextWeekday(today: string, name: string) {
	return addDays(today, (DAYS.indexOf(name.toLowerCase()) - weekdayOf(today) + 7) % 7 || 7);
}

function summary(o: Output, lead: string, extra: string[] = []) {
	const changes = (o.changes ?? (o.rows?.[0]?.fields.changes as Change[] | undefined) ?? []) as Change[];
	const after = (field: string) => changes.find((c) => c.field === field)?.after;
	if (o.status === "refused") return say(`I can't prepare that invitation: ${String(o.refusal)}`);
	const m = after("meeting") as { title: string; when: string; venue: string | null; isNew: boolean } | undefined;
	const list = (field: string) => (Array.isArray(after(field)) ? (after(field) as { name: string }[]) : []);
	const left = list("leftOut");
	return say(
		`${lead} One review shows every step together:`,
		"",
		`- ${m?.isNew ? "Create" : "Meeting:"} ${m?.title ?? "the meeting"}, ${m?.when ?? ""}${m?.venue ? ` at ${m.venue}` : ""}`,
		`- Add ${list("guests").length} guests: ${list("guests")
			.map((g) => g.name)
			.join(", ")}`,
		`- Send the invitation to ${list("recipients").length}: ${list("recipients")
			.map((g) => g.name)
			.join(", ")}`,
		...(left.length ? [`- Left out of the email: ${left.map((g) => g.name).join(", ")}`] : []),
		"",
		...extra,
		"Nothing is created, added or sent until you approve the review.",
	);
}

export function invitationStep(options: LanguageModelV4CallOptions, text: string): LanguageModelV4Content[] | null {
	const prompt = options.prompt;
	const tools = options.tools ?? [];
	const has = (name: string) => tools.some((t) => t.name === name);
	const propose = tools.find((t) => t.name === "propose_change");
	const can = (operation: string) => !!propose && JSON.stringify(propose).includes(`"${operation}"`);
	const start = lastUser(prompt);
	const before = prompt.slice(0, start).findLast((m) => m.role === "user");
	const pickedFor = before && !SET_UP.test(text) && text.trim().length <= 60 ? SET_UP.exec(textOf(before)) : null;
	const invite = INVITE.exec(text);
	const setUp = SET_UP.exec(text) ?? pickedFor;
	const follow = FOLLOW.exec(text);
	if (!invite && !setUp && !REUSE.test(text) && !PLAN.test(text) && !follow) return null;
	const outputs = turnOutputs(prompt);
	const last = outputs.at(-1);

	if (PLAN.test(text)) {
		if (!has("workflows_read")) return say("I can't read the follow-up plan in this context.");
		if (!outputs.length)
			return call("workflows_read", {
				operation: "evry.readWorkflowHint",
				input: { workflow: "vision_night_follow_up" },
			});
		const steps = rowsOf(last, "step");
		if (!steps.length)
			return say(
				"Your seat can't take the follow-up steps after a vision night. An Owner or Admin of this church can.",
			);
		return say(
			"Here is a follow-up plan after vision night, using what Everyfield can do for your role:",
			"",
			...steps.map((s, n) => `${n + 1}. ${s.label}. Say "${String(s.fields.say)}".`),
			"",
			"Each step opens its own review card when you ask for it. Nothing runs from this list.",
		);
	}
	if (last?.error === "source_unavailable" && REUSE.test(text))
		return say("I can't find an invitation you approved through Evry to do again.");
	if (last?.error) return say(`I could not prepare that (${last.error}).`);

	if (follow) {
		if (!can("tasks.createFollowUp")) return say(OWNER_ONLY);
		if (typeof last?.proposalId === "string")
			return say("I prepared the follow-up for your review. Nothing is created until you approve it.");
		if (!outputs.length)
			return call("people_read", { operation: "people.listPeople", input: { search: captured(follow, 1) } });
		const people = rowsOf(last, "person");
		const [only] = people;
		if (!only || people.length > 1)
			return say(people.length ? `${people.length} people match. Which one do you mean?` : "I can't find that person.");
		return call("propose_change", { operation: "tasks.createFollowUp", input: { personId: only.id } });
	}

	if (invite) {
		if (!can("evry.prepareMeetingInvitation")) return say(OWNER_ONLY);
		const family = invite[1];
		const group = invite[2];
		if (typeof last?.proposalId === "string")
			return summary(last, `I prepared the invitation for the ${family ? `${family} household` : group}.`);
		if (family && !outputs.length)
			return call("peopleOrganization_read", { operation: "people.listHouseholds", input: { search: family } });
		const homes = rowsOf(outputs[0], "household");
		const [home] = homes;
		if (family && (!home || homes.length > 1))
			return say(
				homes.length
					? `${homes.length} households match: ${homes.map((h) => h.label).join(", ")}. Which one?`
					: "I can't find that household in People.",
			);
		const listed = outputs.find((o) => o.operation === "meetings.list");
		if (!listed)
			return call("meetings_read", {
				operation: "meetings.list",
				input: { window: "upcoming", types: ["vision_meeting"], limit: 1 },
			});
		const [next] = rowsOf(listed, "meeting");
		if (!next) return say("No vision meeting is coming up in Meetings. Should I set one up and invite them?");
		return call("propose_change", {
			operation: "evry.prepareMeetingInvitation",
			input: {
				meetingId: next.id,
				audience: home && family ? { householdIds: [home.id] } : { groups: [GROUP[String(group).toLowerCase()]] },
			},
		});
	}

	if (setUp) {
		if (!can("evry.prepareMeetingInvitation")) return say(OWNER_ONLY);
		const group = captured(setUp, 3);
		if (typeof last?.proposalId === "string")
			return summary(last, `I prepared the new vision meeting and the invitation for the ${group}.`, [
				"I set it for 6:30 PM Central. Tell me if you want another time.",
			]);
		const place = pickedFor ? text.trim().replace(/^the /i, "").replace(/\.$/, "") : captured(setUp, 2);
		if (!outputs.length) return call("meetings_read", { operation: "venues.list", input: { search: place } });
		const venues = rowsOf(last, "venue");
		const [venue] = venues;
		if (!venue || venues.length > 1)
			return say(
				venues.length
					? `${venues.length} saved venues match "${place}": ${venues.map((v) => v.label).join(" and ")}. Which one should it be? I won't prepare anything until you choose.`
					: `I can't find a saved venue called "${place}". Which venue should it be?`,
			);
		return call("propose_change", {
			operation: "evry.prepareMeetingInvitation",
			input: {
				meeting: {
					type: "vision_meeting",
					date: nextWeekday(churchToday(prompt), captured(setUp, 1)),
					time: "18:30",
					venueId: venue.id,
				},
				audience: { groups: [GROUP[group.toLowerCase()]] },
			},
		});
	}

	if (!can("evry.reuseRecipe")) return say(OWNER_ONLY);
	if (typeof last?.proposalId === "string")
		return summary(last, "I prepared this month's invitation the same way as last time.", [
			"It's a new review with this month's meeting and today's people. Last month's approval doesn't carry over.",
		]);
	if (!outputs.length)
		return call("meetings_read", {
			operation: "meetings.list",
			input: { window: "upcoming", types: ["vision_meeting"], limit: 50 },
		});
	const month = churchToday(prompt).slice(0, 7);
	const meeting = rowsOf(last, "meeting").find((r) => String(r.fields.date).startsWith(month));
	if (!meeting) return say("No vision night is left in Meetings this month.");
	return call("propose_change", { operation: "evry.reuseRecipe", input: { meetingId: meeting.id } });
}
