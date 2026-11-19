import {
	createFollowUpWriter,
	followUpReader,
	withFollowUpWrite,
} from "../../../packages/domain/src/followups/index.ts";
import { planNoReminders } from "./tenancy-meetings.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

const followups = createFollowUpWriter({ reminders: planNoReminders });
const asOf = "2026-11-01T12:00:00.000Z";

export async function seedFollowUps(t) {
	const { a, MARK, key, ok } = t;
	const write = (op, input) => withFollowUpWrite(t.f.db, t.ownerA.actor, (tx, c) => followups[op](tx, c, input));
	const duty = ok(
		await gatedTransaction(t.f.db, (tx) => followUpReader.readObligations(tx, t.ownerA.actor, { meetingId: a.vision })),
	).items.find((o) => o.person?.id === a.blair);
	const assigned = ok(
		await write("assignFollowUp", {
			requestKey: key(),
			expectedRevision: duty.task.revision,
			input: { taskId: duty.task.id, assigneeIds: [t.ownerA.id] },
		}),
	);
	ok(
		await write("recordOutcome", {
			requestKey: key(),
			input: {
				target: { kind: "task", taskId: duty.task.id, expectedRevision: assigned.task.revision },
				outcome: "contacted",
				occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
				channel: "phone",
				notes: `${MARK} contact notes`,
				completeTask: false,
			},
		}),
	);
}

export function followUpsCases(t, who) {
	const { a } = t;
	const read = (op, input) => gatedTransaction(t.f.db, (tx) => followUpReader[op](tx, who.actor, input));
	const f = (name, input, expected) => [`followups:followUpReader.${name}`, { run: () => read(name, input), expected }];
	const unavailable = { refused: "unavailable" };
	const page = { page: 1, next: null, completeness: "complete" };
	return [
		f("listContactHistory", { personId: a.blair }, { ...unavailable, echo: [a.blair] }),
		f(
			"readObligations",
			{ meetingId: a.vision, asOf },
			{ value: { asOf, items: [], total: 0, ...page }, echo: [a.vision] },
		),
		f(
			"followUpCoverage",
			{ personId: a.blair, asOf },
			{
				value: { items: [], owners: [], formerOwners: [], needsOwner: 0, uncovered: 0, total: 0, ...page },
				echo: [a.blair],
			},
		),
		f(
			"listFollowUpOwners",
			{ personId: a.blair, asOf },
			{ value: { items: [], owners: [], unassigned: 0, matched: 0, ...page }, echo: [a.blair] },
		),
		f("planHandoff", { fromAccountId: t.ownerA.id }, { ...unavailable, echo: [t.ownerA.id] }),
	];
}
