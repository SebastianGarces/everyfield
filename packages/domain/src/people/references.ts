import { and, asc, eq, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import type { Tx } from "./core.ts";
import { deny } from "./core.ts";
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
