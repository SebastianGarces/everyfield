import { sql } from "drizzle-orm";
import { database, closeDatabase } from "../src/client.js";
import { early_access_request } from "../src/schema/tables.js";

const developmentHosts = new Set([
	"ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech",
	"ep-autumn-dew-b8ltidky-pooler.c-14.us-east-1.aws.neon.tech",
]);
let allowed = false;
try {
	allowed = developmentHosts.has(new URL(process.env.DATABASE_URL ?? "").hostname);
} catch {
	/* Refuse without exposing settings. */
}
if (!allowed || process.env.NODE_ENV === "production") {
	console.error("Reset refused. Use the everyfield-v3 shared development database outside production.");
	process.exit(1);
}
const db = database();
try {
	await db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(7341097)`);
		await tx.execute(sql`TRUNCATE early_access_request,early_access_attempt`);
		for (const [kind, email, data] of [
			[
				"planter",
				"planter@example.test",
				{ name: "Sample Planter", plant_name: "Sample Plant", city: "Sample City", phase: "0 · Discovery" },
			],
			[
				"network",
				"network@example.test",
				{
					name: "Sample Network Lead",
					organization: "Sample Network",
					role: "Coordinator",
					plants: 3,
					message: "Synthetic development fixture",
				},
			],
		] as const)
			await tx
				.insert(early_access_request)
				.values({
					kind,
					email,
					data: { ...data, email },
					mail_payload: {
						from: "EveryField Development <development@example.test>",
						to: [email],
						reply_to: "support@example.test",
						subject: "Synthetic development fixture",
						text: "No email was sent.",
					},
					mail_id: "synthetic-" + kind,
					mailed_at: sql`now()`,
				});
	});
	console.log("Shared development database reset. Seeded one planter and one network request; no email sent.");
} catch {
	console.error("Development reset failed. Apply the current migrations first. No credential values were logged.");
	process.exitCode = 1;
} finally {
	await closeDatabase(db);
}
