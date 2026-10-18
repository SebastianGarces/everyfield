import { database } from "../src/index.js";

// This endpoint belongs only to everyfield-v3's shared development branch.
const developmentHosts = new Set([
	"ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech",
	"ep-autumn-dew-b8ltidky-pooler.c-14.us-east-1.aws.neon.tech",
]);
let allowed = false;
try {
	allowed = developmentHosts.has(new URL(process.env.DATABASE_URL ?? "").hostname);
} catch {
	// Invalid or missing connection strings are refused without exposing them.
}
if (!allowed || process.env.NODE_ENV === "production") {
	console.error("Reset refused. Use the everyfield-v3 shared development database outside production.");
	process.exit(1);
}

const db = database();
const client = await db.connect().catch(async () => {
	console.error("Development connection failed. No credential values were logged.");
	await db.end();
	process.exit(1);
});
try {
	await client.query("BEGIN");
	await client.query("SELECT pg_advisory_xact_lock(7341097)");
	await client.query("TRUNCATE early_access_request, early_access_attempt");
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
	] as const) {
		await client.query(
			`
      INSERT INTO early_access_request (kind, email, data, mail_payload, mail_id, mailed_at)
      VALUES ($1, $2, $3, $4, $5, now())
    `,
			[
				kind,
				email,
				JSON.stringify({ ...data, email }),
				JSON.stringify({
					from: "EveryField Development <development@example.test>",
					to: [email],
					reply_to: "support@example.test",
					subject: "Synthetic development fixture",
					text: "No email was sent.",
				}),
				"synthetic-" + kind,
			],
		);
	}
	await client.query("COMMIT");
	console.log("Shared development database reset. Seeded one planter and one network request; no email sent.");
} catch {
	await client.query("ROLLBACK");
	console.error("Development reset failed. Apply the current migrations first. No credential values were logged.");
	process.exitCode = 1;
} finally {
	client.release();
	await db.end();
}
