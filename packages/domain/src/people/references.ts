import { and, asc, eq, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import * as c from "@everyfield/contracts/people";
import type { z } from "zod";
import { deny, expected, live, person } from "./core.ts";
import type { Tx } from "./core.ts";
// Internal consumer protocol. The authenticated consumer owns authority and calls
// this inside the same transaction before inserting its current Person reference.
export async function lockPersonReference(tx: Tx, input: z.infer<typeof c.lockedPersonReference>) {
	const reference = c.lockedPersonReference.parse(input);
	const p = await person(tx, { selected: reference.owner }, reference.personId, true);
	live(p);
	expected(p, reference.revision);
	return c.lockedPersonReference.parse({
		owner: reference.owner,
		personId: p.id,
		revision: p.revision,
		state: "live",
	});
}
// Account removal keeps independently owned Person facts. Cleanup supplies the
// real account under its lifecycle lock; creator identity never selects ownership.
export async function detachAccountPersonLinks(tx: Tx, accountId: string) {
	const pending = await tx
		.select({ id: tables.lifecycle_witness.id })
		.from(tables.lifecycle_witness)
		.where(
			and(
				eq(tables.lifecycle_witness.account_id, accountId),
				sql<boolean>`(${tables.lifecycle_witness.state} IN ('purging', 'purged'))`,
			),
		)
		.for("share");
	if (!pending.length) deny();
	const persons = await tx
		.select({ id: tables.person.id })
		.from(tables.person)
		.where(eq(tables.person.linked_account_id, accountId))
		.orderBy(asc(tables.person.id))
		.for("update");
	await tx
		.update(tables.person)
		.set({ linked_account_id: null, revision: sql<unknown>`(${tables.person.revision} + 1)` })
		.where(eq(tables.person.linked_account_id, accountId));
	await tx.execute(sql`SELECT scrub_people_account_author(${sql.param(accountId)})`);
	return { retainedPersonIds: persons.map((p) => p.id) };
}
