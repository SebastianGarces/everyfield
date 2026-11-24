import {
	createFollowUpWriter,
	followUpReader,
	withFollowUpWrite,
} from "../../../packages/domain/src/followups/index.ts";
import { planNoReminders } from "./tenancy-meetings.mts";
import type { WriteTx } from "../../../packages/domain/src/access/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { casesFor, type Tenancy, type TenancyOwner } from "./tenancy-case.mts";

const followups = createFollowUpWriter({ reminders: planNoReminders });
const asOf = "2026-11-01T12:00:00.000Z";

export async function seedFollowUps(t: Tenancy) {
	const { a, MARK, key, ok } = t;
	const write = <V,>(body: Parameters<typeof withFollowUpWrite<V>>[2]) =>
		withFollowUpWrite(t.f.db, t.ownerA.actor, body);
	const duty = ok(
		await gatedTransaction(t.f.db, (tx) => followUpReader.readObligations(tx, t.ownerA.actor, { meetingId: a.vision })),
	).items.find((o) => o.person?.id === a.blair)!;
	const assigned = ok(
		await write((tx, c) =>
			followups.assignFollowUp(tx, c, {
				requestKey: key(),
				expectedRevision: duty.task!.revision,
				input: { taskId: duty.task!.id, assigneeIds: [t.ownerA.id] },
			}),
		),
	);
	ok(
		await write((tx, c) =>
			followups.recordOutcome(tx, c, {
				requestKey: key(),
				input: {
					target: { kind: "task", taskId: duty.task!.id, expectedRevision: assigned.task.revision },
					outcome: "contacted",
					occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
					channel: "phone",
					notes: `${MARK} contact notes`,
					completeTask: false,
				},
			}),
		),
	);
}

export function followUpsCases(t: Tenancy, who: TenancyOwner) {
	const { a } = t;
	const f = casesFor("followups:followUpReader.");
	const read = <V,>(body: (tx: WriteTx) => Promise<V>) => gatedTransaction(t.f.db, body);
	const unavailable = { refused: "unavailable" };
	const page = { page: 1, next: null, completeness: "complete" };
	return [
		f(
			"listContactHistory",
			() => read((tx) => followUpReader.listContactHistory(tx, who.actor, { personId: a.blair })),
			{ ...unavailable, echo: [a.blair] },
		),
		f(
			"readObligations",
			() => read((tx) => followUpReader.readObligations(tx, who.actor, { meetingId: a.vision, asOf })),
			{ value: { asOf, items: [], total: 0, ...page }, echo: [a.vision] },
		),
		f(
			"followUpCoverage",
			() => read((tx) => followUpReader.followUpCoverage(tx, who.actor, { personId: a.blair, asOf })),
			{
				value: { items: [], owners: [], formerOwners: [], needsOwner: 0, uncovered: 0, total: 0, ...page },
				echo: [a.blair],
			},
		),
		f(
			"listFollowUpOwners",
			() => read((tx) => followUpReader.listFollowUpOwners(tx, who.actor, { personId: a.blair, asOf })),
			{ value: { items: [], owners: [], unassigned: 0, matched: 0, ...page }, echo: [a.blair] },
		),
		f("planHandoff", () => read((tx) => followUpReader.planHandoff(tx, who.actor, { fromAccountId: t.ownerA.id })), {
			...unavailable,
			echo: [t.ownerA.id],
		}),
	];
}
