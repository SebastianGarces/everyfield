import { closeDatabase, createDatabase } from "@everyfield/db/client";
import { backfill, migrate } from "@everyfield/db/migrate";
import { residentDiscoveryBackfill } from "../src/onboarding/backfill.ts";
import { commitmentCacheBackfill, mergeReferencesBackfill } from "../src/people/commitments/backfill.ts";

const backfills = [commitmentCacheBackfill(), mergeReferencesBackfill(), residentDiscoveryBackfill()];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const db = createDatabase({ connectionString, max: 5 });
try {
	const applied = await migrate(db);
	const done = await backfill(db, backfills);
	console.log(
		`Database migrations current. Applied ${applied.length} migration(s) and ${done.length} backfill(s).` +
			done.map((b) => `\nBackfill ${b.name}: ${b.changed} row(s) changed.`).join(""),
	);
} catch {
	console.error("Database migration failed. No credential values were logged.");
	process.exitCode = 1;
} finally {
	await closeDatabase(db);
}
