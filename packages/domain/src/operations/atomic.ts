import type { Pool, PoolClient } from "pg";
import { writeRequiredConsequences } from "@everyfield/contracts/common";
import type { RequiredWrites } from "@everyfield/contracts/common";

// Internal producer protocol only. There is no event name, handler lookup or public RPC.
// Authorizers lock the current source and validate owner, lifecycle, replay and revision.
export async function inTransaction<Result>(db: Pool, body: (tx: PoolClient) => Promise<Result>): Promise<Result> {
	const tx = await db.connect();
	try {
		await tx.query("BEGIN");
		await tx.query("SET LOCAL statement_timeout='5s'");
		await tx.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
		const result = await body(tx);
		await tx.query("COMMIT");
		return result;
	} catch (error) {
		await tx.query("ROLLBACK");
		throw error;
	} finally {
		tx.release();
	}
}

export function executeAtomicConsequences<Result>(
	db: Pool,
	authorize: (tx: PoolClient) => Promise<void>,
	writes: RequiredWrites<PoolClient, Result>,
): Promise<Result> {
	return inTransaction(db, async (tx) => {
		await authorize(tx);
		return writeRequiredConsequences(tx, writes);
	});
}
