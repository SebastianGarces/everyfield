// Puts this test process on the database's clock. The suites stamp times from the host (`accepted_at: new Date()`, an
// `eligibleAt`, a proof's `provenAt`, a webhook's `createdAt`), and the product compares them with the database's
// `clock_timestamp()`: a seat counts only once `accepted_at<=clock_timestamp()`. CI runs Postgres on the runner's own
// clock. A local container runs on a VM clock (Docker Desktop on macOS) that can lag the host by tens of milliseconds,
// so a fresh seat reads as not yet accepted (`invitation_unavailable`, `proof_invalid`, `unavailable`).
//
// Import this first. It reads the database clock and, when the host could be ahead of it, moves every host `Date` back
// so the host trails the database by `MARGIN_MS`. A host that trails the database is what CI already has; a few
// milliseconds of trail do not change what any suite asserts. It moves only this process's clock, never a product check.
import { closeDatabase, createDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { testDatabaseUrl } from "../../support/test-database.mts";

const MARGIN_MS = 5;
const SAMPLES = 5;

/** The least the database clock can be ahead of the host, in ms: each read happened before the host's `Date.now()` after it. */
async function databaseLead(): Promise<number> {
	const db = createDatabase({ connectionString: testDatabaseUrl().href, max: 1 });
	try {
		let lead = -Infinity;
		for (let i = 0; i < SAMPLES; i++) {
			const [row] = (await db.execute(sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms`))
				.rows as { ms: number }[];
			const hostStamp = Date.now(); // read after the database's, so the difference never overstates its lead
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
