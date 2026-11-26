import { writeFile } from "node:fs/promises";
import { closeDatabase, createDatabase } from "@everyfield/db/client";
import { exportAccessRequests } from "../src/early-access/store.ts";

const file = process.argv[2];
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const db = createDatabase({ connectionString, max: 5 });
try {
	const csv = await exportAccessRequests(db);
	if (file) {
		await writeFile(file, csv, { mode: 0o600, flag: "wx" });
		console.log("Early access requests exported.");
	} else {
		process.stdout.write(csv);
	}
} catch {
	console.error("Export failed. Check database access and choose a new output path.");
	process.exitCode = 1;
} finally {
	await closeDatabase(db);
}
