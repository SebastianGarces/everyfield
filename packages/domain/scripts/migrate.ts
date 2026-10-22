import { closeDatabase, database } from "@everyfield/db/client";
import { backfill, migrate } from "@everyfield/db/migrate";
import { commitmentCacheBackfill, mergeReferencesBackfill } from "../src/people/commitments/backfill.ts";

// db:migrate, the only migration runner (C102): the SQL migrations, then the registered one-time backfills, which use
// domain rules and so live here rather than in packages/db.
const backfills = [commitmentCacheBackfill(), mergeReferencesBackfill()];

const db = database();
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
