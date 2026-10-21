import "server-only";
import { after } from "next/server";
import { requestDatabase } from "../database";
import { runDueImports } from "./run-imports";

/** After the response, runs due People CSV imports. The import and receipt routes call it. */
export function drainPeopleImports() {
	after(async () => {
		const pool = requestDatabase();
		if (pool) await runDueImports(pool);
	});
}
