import { database, closeDatabase } from "../src/client.ts";
import { migrate } from "../src/schema/migrate.js";
const db = database();
try {
	const applied = await migrate(db);
	console.log(`Database migrations current. Applied ${applied.length} migration(s).`);
} catch {
	console.error("Database migration failed. No credential values were logged.");
	process.exitCode = 1;
} finally {
	await closeDatabase(db);
}
