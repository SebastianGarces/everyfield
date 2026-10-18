import { sql } from "@everyfield/db/query";
import type { Database, Transaction } from "@everyfield/db/client";
import { writeRequiredConsequences } from "@everyfield/contracts/common";
import type { RequiredWrites } from "@everyfield/contracts/common";

// Internal producer protocol only. There is no event name, handler lookup or public RPC.
// Authorizers lock the current source and validate owner, lifecycle, replay and revision.
export async function inTransaction<Result>(db: Database, body: (tx: Transaction) => Promise<Result>): Promise<Result> {
	return db.transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
		await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
		return body(tx);
	});
}

export function executeAtomicConsequences<Result>(
	db: Database,
	authorize: (tx: Transaction) => Promise<void>,
	writes: RequiredWrites<Transaction, Result>,
): Promise<Result> {
	return inTransaction(db, async (tx) => {
		await authorize(tx);
		return writeRequiredConsequences(tx, writes);
	});
}
