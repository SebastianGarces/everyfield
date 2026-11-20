import "server-only";
import type { Database } from "@everyfield/db/client";
import type { WriteTx } from "@everyfield/domain/access";
import type { LogWord } from "@everyfield/domain/log";
import { gatedTransaction } from "@everyfield/domain/operations";
import { requestDatabase } from "../database.ts";
import { LOST, transient } from "./transient.ts";

export function readTx<const C extends string, T>(component: LogWord<C>, run: (tx: WriteTx) => Promise<T>) {
	return transient({ component, outcome: "read_failed" }, () => gatedTransaction(requestDatabase(), run), LOST);
}

export function readDb<const C extends string, T>(component: LogWord<C>, run: (db: Database) => Promise<T>) {
	return transient({ component, outcome: "read_failed" }, () => run(requestDatabase()), LOST);
}

export function guardedWrite<const C extends string, T>(component: LogWord<C>, run: () => Promise<T>) {
	return transient({ component, outcome: "write_failed" }, run, LOST);
}
