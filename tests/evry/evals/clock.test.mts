import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { evalDatabase, NOW, seedHope } from "./golden-church.mts";

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

test("BUG-launch-midnight: a Launch run that crosses Chicago midnight keeps the dates it seeded", async (t) => {
	const Real = Date;
	let host = Real.parse("2026-11-25T05:59:00Z");
	globalThis.Date = class extends Real {
		constructor(...args: unknown[]) {
			if (args.length) super(...(args as [string]));
			else super(host);
		}
		static override now() {
			return host;
		}
	} as DateConstructor;
	t.after(() => {
		globalThis.Date = Real;
	});
	const launch = await import("./launch-church.mts");
	const database = await evalDatabase({ prefix: "evrymidnight" });
	try {
		const { admin } = database;
		const db = database.pools.runtime;
		await seedHope(admin, { seatNames: true });
		await launch.seedScheduled(admin, db);
		await launch.seedLaunched(db);
		await launch.seedOutcome(db, 150);
		const before = await launch.planOf(db);
		host = Real.parse("2026-11-25T06:01:00Z");
		const after = await launch.planOf(db);
		assert.deepEqual(
			[after.outcome?.actualDate, after.launch?.targetDate, after.today],
			[launch.day(-2), launch.day(-2), launch.day(0)],
		);
		assert.deepEqual(after, before);
	} finally {
		await database.close();
	}
});
