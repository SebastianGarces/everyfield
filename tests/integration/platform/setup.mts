import { closeDatabase, createDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { testDatabaseUrl } from "../../support/test-database.mts";

const MARGIN_MS = 5;
const SAMPLES = 5;

async function databaseLead(): Promise<number> {
	const db = createDatabase({ connectionString: testDatabaseUrl().href, max: 1 });
	try {
		let lead = -Infinity;
		for (let i = 0; i < SAMPLES; i++) {
			const [row] = (await db.execute(sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms`))
				.rows as { ms: number }[];
			const hostStamp = Date.now();
			lead = Math.max(lead, Number(row.ms) - hostStamp);
		}
		return lead;
	} finally {
		await closeDatabase(db);
	}
}

const lead = await databaseLead();
if (lead < MARGIN_MS) {
	const shift = lead - MARGIN_MS;
	const Host = Date;
	const now = () => Host.now() + shift;
	globalThis.Date = new Proxy(Host, {
		construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now()], newTarget),
		apply: () => new Host(now()).toString(),
		get: (target, property, receiver) => (property === "now" ? now : Reflect.get(target, property, receiver)),
	});
}
