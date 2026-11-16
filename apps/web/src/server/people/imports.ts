import "server-only";
import { after } from "next/server";
import { requestDatabase } from "../database";
import { runDueImports } from "./run-imports";

export function drainPeopleImports() {
	after(async () => {
		const pool = requestDatabase();
		if (pool) await runDueImports(pool);
	});
}
