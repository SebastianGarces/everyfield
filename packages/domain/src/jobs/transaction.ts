import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import "server-only";

export async function transaction<T>(pool: Database, body: (tx: Transaction) => Promise<T>): Promise<T> {
	return pool.transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
		return body(tx);
	});
}
