import type { Database } from "@everyfield/db/client";
import type { PrivateStorage } from "@everyfield/db/schema";
import type { TaskReminders } from "@everyfield/domain/tasks";
import { closeLostJobs } from "@everyfield/evry";
import {
	cancelUnsubscribedHeld,
	runDueScheduled,
	type DeliveryKeys,
	type DeliveryTransport,
} from "@everyfield/domain/communication";
import { timingSafeEqual } from "node:crypto";
import "server-only";
import { runEffects, runTurns } from "../evry/worker.ts";
import { runDueImports } from "../people/run-imports.ts";
import { transaction } from "../platform/database.ts";
import { planDigests, type DigestWorker } from "./digest.ts";
import { runDuePurges } from "./lifecycle-purge.ts";
import { runDueObjectCleanup } from "./object-cleanup.ts";

/**
 * A job starts only in the first minute of a run, so a normal run ends well inside the route's 300 s. Every statement
 * has a database timeout: 5 s on the job pool, or its boundary's own (the native write gate sets 10 s, lock waits 5 s).
 * A file delete aborts after 10 s and a turn ends at its 180-second wall time. A job that still runs past the route's
 * limit (a large import whose rows fail one by one) is stopped by the platform; its lease returns it to recovery,
 * fenced, and rows it already imported are skipped when it resumes.
 */
const START_MS = 60_000;

type StepStatus = { status: "ok"; count: unknown } | { status: "skipped" } | { status: "failed" };
/** A step's component name, the count key the body has always used (null: none), and its run, or null when unconfigured. */
type Step = readonly [component: string, key: string | null, run: (() => Promise<unknown>) | null];

/**
 * The runner's Messages work (T-241): cancel what the email service already holds for people who unsubscribed, then
 * hand each due scheduled email to the email service, checking every recipient's opt-out at that moment.
 */
export function scheduledMessages(db: Database, transport: DeliveryTransport, keys: DeliveryKeys) {
	return async (limit: number, until: number) =>
		(await cancelUnsubscribedHeld(db, transport, 50)) + (await runDueScheduled(db, transport, keys, limit, until));
}

/**
 * The scheduled runner (Vercel cron, every minute): one bounded batch of every job kind that has a worker, so due work
 * runs and lost work is recovered with no page open. It first closes Evry jobs that can no longer make progress, then
 * runs the existing workers, each of which returns expired leases to the queue first. Requested deletions whose
 * cancellation deadline has passed are purged on the cleanup login (`lifecycle_purge`). It queues the digests whose period
 * ended at the run's clock and delivers a bounded batch of them (WP-030). The workers claim with SKIP
 * LOCKED, so ticks that overlap each other or a request's own drain never run one job twice. The schedule grants no
 * business authority: every worker rechecks its own fences and sources. Church invitation mail runs here through
 * `mail`, and scheduled Messages email through `messages`. Other queued mail (identity, settings, organization connection, task, onboarding, phase and digest mail) has
 * no sending worker yet: each mount still holds it with a refusing transport (see the WP-028 PR follow-ups).
 *
 * Each step runs in its own try, so one that throws (a provider outage, a lost connection) logs one line naming its
 * component and the later steps still run in the same tick; its own jobs wait for their lease or retry. The body keeps
 * each step's count under its old name and adds `steps`: every step's `ok` with its count, `skipped` when the
 * deployment does not configure it, or `failed`; `failed` lists the failed components. A tick with a failed step answers
 * 500 with `status: "failed"`, so the cron log shows the run as failed while the body shows which work still ran; a tick
 * where every step ran answers 200 with `status: "ok"`.
 */
export function scheduledJobs(config: {
	secret: string | undefined;
	db: Database | null;
	storage: PrivateStorage | null;
	/**
	 * The cleanup login's pool, which alone may purge a deleted account or church; null on a deployment without it. With
	 * no cleanup login or no private storage, requested deletions wait and every other worker still runs.
	 */
	cleanup: Database | null;
	reminders: TaskReminders | null;
	/** Sends one bounded batch of due invitation mail; null when the deployment has no mail transport. */
	mail: ((limit: number, until: number) => Promise<number>) | null;
	/**
	 * Hands due scheduled Messages email to the email service at its send time, checking opt-outs then, and cancels
	 * emails the email service already holds for people who unsubscribed (T-241). Null without mail configuration.
	 */
	messages?: ((limit: number, until: number) => Promise<number>) | null;
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
		const asOf = (config.now?.() ?? new Date()).toISOString();
		const { storage, cleanup, reminders, digests, mail } = config;
		const messages = config.messages ?? null;
		const steps: Step[] = [
			["close-lost-jobs", "closed", () => transaction(db, (tx) => closeLostJobs(tx))],
			["people-import", null, () => runDueImports(db, 4, until)],
			["object-cleanup", "removed", storage && (() => runDueObjectCleanup(db, storage, 4, until))],
			["lifecycle-purge", "purged", cleanup && storage && (() => runDuePurges(db, cleanup, storage, 2, until))],
			["evry-effect", "effects", reminders && (() => runEffects(db, reminders, 4, until))],
			["assistant-turn", "turns", () => runTurns(db, 4, until)],
			["digest-planning", "planned", digests && (() => planDigests(db, asOf))],
			["digest-delivery", "digests", digests && (() => digests.run(db, asOf, undefined, until))],
			["mail", "mailed", mail && (() => mail(20, until))],
			["messages", "messages", messages && (() => messages(20, until))],
		];
		// The counts a tick has always reported; a step that is skipped or fails keeps its default.
		const counts: Record<string, unknown> = {
			closed: null,
			removed: 0,
			purged: 0,
			effects: 0,
			turns: 0,
			planned: null,
			digests: 0,
			mailed: 0,
			messages: 0,
		};
		const report: Record<string, StepStatus> = {};
		for (const [component, key, run] of steps) {
			if (!run) {
				report[component] = { status: "skipped" };
				continue;
			}
			try {
				const count = await run();
				report[component] = { status: "ok", count: count ?? null };
				if (key) counts[key] = count;
			} catch {
				// No error text: it can carry row values.
				console.error(JSON.stringify({ component, runner: "scheduled-jobs", outcome: "error" }));
				report[component] = { status: "failed" };
			}
		}
		const failed = Object.keys(report).filter((component) => report[component]!.status === "failed");
		return Response.json(
			{ status: failed.length ? "failed" : "ok", ...counts, failed, steps: report },
			{ status: failed.length ? 500 : 200 },
		);
	};
}
