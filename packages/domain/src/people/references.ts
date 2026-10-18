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
	const pending = await tx.query(
		"SELECT id FROM lifecycle_witness WHERE account_id=$1 AND state IN ('purging','purged') FOR SHARE",
		[accountId],
	);
	if (!pending.rowCount) deny();
	const persons = await tx.query("SELECT id FROM person WHERE linked_account_id=$1 ORDER BY id FOR UPDATE", [
		accountId,
	]);
	await tx.query("UPDATE person SET linked_account_id=NULL,revision=revision+1 WHERE linked_account_id=$1", [
		accountId,
	]);
	await tx.query("SELECT scrub_people_account_author($1)", [accountId]);
	return { retainedPersonIds: persons.rows.map((p) => p.id) };
}
