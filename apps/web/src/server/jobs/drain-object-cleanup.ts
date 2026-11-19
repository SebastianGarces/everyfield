import "server-only";
import { privateStorage } from "@everyfield/db/schema";
import { after } from "next/server";
import { requestDatabase } from "../database.ts";
import { runDueObjectCleanup } from "./object-cleanup.ts";

export function drainObjectCleanup() {
	after(async () => {
		const storage = privateStorage();
		if (storage) await runDueObjectCleanup(requestDatabase(), storage, 4);
	});
}
