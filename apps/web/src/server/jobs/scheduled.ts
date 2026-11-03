import type { Database } from "@everyfield/db/client";
import type { PrivateStorage } from "@everyfield/db/schema";
import type { TaskReminders } from "@everyfield/domain/tasks";
import { closeLostJobs } from "@everyfield/evry";
import { timingSafeEqual } from "node:crypto";
import "server-only";
import { runEffects, runTurns } from "../evry/worker.ts";
import { runDueImports } from "../people/run-imports.ts";
import { transaction } from "../platform/database.ts";
import { planDigests, type DigestWorker } from "./digest.ts";
import { runDueObjectCleanup } from "./object-cleanup.ts";

/**
 * A job starts only in the first minute of a run, so a normal run ends well inside the route's 300 s. Every statement
 * has a database timeout: 5 s on the job pool, or its boundary's own (the native write gate sets 10 s, lock waits 5 s).
 * A file delete aborts after 10 s and a turn ends at its 180-second wall time. A job that still runs past the route's
 * limit (a large import whose rows fail one by one) is stopped by the platform; its lease returns it to recovery,
 * fenced, and rows it already imported are skipped when it resumes.
 */
const START_MS = 60_000;

/**
 * The scheduled runner (Vercel cron, every minute): one bounded batch of every job kind that has a worker, so due work
 * runs and lost work is recovered with no page open. It first closes Evry jobs that can no longer make progress, then
 * runs the existing workers, each of which returns expired leases to the queue first. It queues the digests whose period
 * ended at the run's clock and delivers a bounded batch of them (WP-030). The workers claim with SKIP
 * LOCKED, so ticks that overlap each other or a request's own drain never run one job twice. The schedule grants no
 * business authority: every worker rechecks its own fences and sources. Church invitation mail runs here through
 * `mail`. Other queued mail (identity, settings, organization connection, task, onboarding, phase, notification and
 * digest mail) has no sending worker yet: each mount still holds it with a refusing transport (see the WP-028 PR follow-ups).
 */
export function scheduledJobs(config: {
	secret: string | undefined;
	db: Database | null;
	storage: PrivateStorage | null;
	reminders: TaskReminders | null;
	/** Sends one bounded batch of due invitation mail; null when the deployment has no mail transport. */
	mail: ((limit: number, until: number) => Promise<number>) | null;
	/** Null on a deployment without mail configuration: no digest is planned or delivered there. */
	digests: DigestWorker | null;
	/** The clock digests are planned and compiled at. Tests move it; the route uses the real time. */
	now?: () => Date;
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
			const asOf = (config.now?.() ?? new Date()).toISOString();
			const planned = config.digests ? await planDigests(db, asOf) : null;
			const digests = config.digests ? await config.digests.run(db, asOf, undefined, until) : 0;
			const mailed = config.mail ? await config.mail(20, until) : 0;
			return Response.json({ status: "ok", closed, removed, effects, turns, planned, digests, mailed });
		} catch {
			// No error text: it can carry row values.
			console.error(JSON.stringify({ component: "scheduled-jobs", outcome: "error" }));
			return Response.json({ status: "unavailable" }, { status: 503 });
		}
	};
}
