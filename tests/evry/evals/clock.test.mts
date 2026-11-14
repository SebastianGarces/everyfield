// The eval database's clock runs in NOW's frame (evalDatabase in golden-church.mts), whatever the real date is. Without
// the pin, a fixture time such as the Friday of NOW's week passes in real life, and the review of ADP-M-04 and ADP-M-07
// refuses it as "already passed".
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { evalDatabase, NOW } from "./golden-church.mts";

const MINUTE = 60_000;

test("the eval pool reads every database clock in NOW's frame", async () => {
	const started = performance.now();
	const database = await evalDatabase({ prefix: "evryclock" });
	try {
		const { rows } = await database.pools.runtime.execute<Record<string, string>>(
			sql`SELECT clock_timestamp()::text AS clock, now()::text AS now, statement_timestamp()::text AS statement,
				transaction_timestamp()::text AS transaction`,
		);
		const latest = NOW.getTime() + (performance.now() - started) + MINUTE;
		for (const [clock, at] of Object.entries(rows[0]!)) {
			const time = new Date(at).getTime();
			assert.ok(
				time >= NOW.getTime() - MINUTE && time <= latest,
				`${clock}() reads ${at}, outside NOW's frame (${NOW.toISOString()} plus the time this test took)`,
			);
		}
	} finally {
		await database.close();
	}
});
