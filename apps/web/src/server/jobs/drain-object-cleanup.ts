import "server-only";
import { privateStorage } from "@everyfield/db/schema";
import { after } from "next/server";
import { requestDatabase } from "../database.ts";
import { runDueObjectCleanup } from "./object-cleanup.ts";

/** After the response, deletes the objects a photo or avatar change released. The scheduled runner (scheduled.ts) catches the rest. */
export function drainObjectCleanup() {
	after(async () => {
		const db = requestDatabase();
		const storage = privateStorage();
		if (db && storage) await runDueObjectCleanup(db, storage, 4);
	});
}
