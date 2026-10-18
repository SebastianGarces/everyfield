import { writeFile } from "node:fs/promises";
import { database, closeDatabase, exportAccessRequests } from "../src/index.js";

const file = process.argv[2];
const db = database();
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
