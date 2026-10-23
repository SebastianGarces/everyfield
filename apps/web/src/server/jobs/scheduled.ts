import type { Database } from "@everyfield/db/client";
import type { PrivateStorage } from "@everyfield/db/schema";
import type { TaskReminders } from "@everyfield/domain/tasks";
import { closeLostJobs } from "@everyfield/evry";
import { timingSafeEqual } from "node:crypto";
import "server-only";
import { runEffects, runTurns } from "../evry/worker.ts";
import { runDueImports } from "../people/run-imports.ts";
import { transaction } from "../platform/database.ts";
import { runDueObjectCleanup } from "./object-cleanup.ts";

/**
 * A job starts only in the first minute of a run. Every statement on the job pool ends within 5 s, a file delete within
 * 10 s, a turn within its 180-second wall time and a People import of at most 10,000 rows within about 22 statements, so
 * the last job started ends inside the route's 300 s. A run the platform still stops leaves leased jobs for recovery.
 */
const START_MS = 60_000;

/**
 * The scheduled runner (Vercel cron, every minute): one bounded batch of every job kind that has a worker, so due work
 * runs and lost work is recovered with no page open. It first closes Evry jobs that can no longer make progress, then
 * runs the existing workers, each of which returns expired leases to the queue first. The workers claim with SKIP
 * LOCKED, so ticks that overlap each other or a request's own drain never run one job twice. The schedule grants no
 * business authority: every worker rechecks its own fences and sources. Mail waits for its worker (WP-028).
 */
export function scheduledJobs(config: {
	secret: string | undefined;
	db: Database | null;
	storage: PrivateStorage | null;
	reminders: TaskReminders | null;
}) {
	return async (request: Request): Promise<Response> => {
		if (!config.secret) return Response.json({ status: "unavailable" }, { status: 503 });
		const expected = Buffer.from(`Bearer ${config.secret}`);
		const actual = Buffer.from(request.headers.get("authorization") ?? "");
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
			return Response.json({ status: "unauthorized" }, { status: 401 });
		const db = config.db;
		if (!db) return Response.json({ status: "unavailable" }, { status: 503 });
		const until = Date.now() + START_MS;
		try {
			const closed = await transaction(db, (tx) => closeLostJobs(tx));
			await runDueImports(db, 4, until);
			const removed = config.storage ? await runDueObjectCleanup(db, config.storage, 4, until) : 0;
			const effects = config.reminders ? await runEffects(db, config.reminders, 4, until) : 0;
			const turns = await runTurns(db, 4, until);
			return Response.json({ status: "ok", closed, removed, effects, turns });
		} catch {
			// No error text: it can carry row values.
			console.error(JSON.stringify({ component: "scheduled-jobs", outcome: "error" }));
			return Response.json({ status: "unavailable" }, { status: 503 });
		}
	};
}
