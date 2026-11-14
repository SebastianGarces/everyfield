import type { Database } from "@everyfield/db/client";
import type { PrivateStorage } from "@everyfield/db/schema";
import { documentsWriter } from "@everyfield/domain/documents";
import { deleteExpiredImportFiles } from "@everyfield/domain/people";
import { closeLostJobs, type EffectPorts } from "@everyfield/evry";
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
import { expireStaleMail, type MailPass, type MailPassName } from "./mail.ts";
import type { NotificationWorker } from "./notification-worker.ts";
import { runDueObjectCleanup } from "./object-cleanup.ts";
import { replayStoredCallbacks } from "./webhook.ts";

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

/** One bounded documents orphan sweep (D-879). Its count is the files purged and the files it could not settle. */
async function sweepOrphans(db: Database, storage: PrivateStorage) {
	const reply = await documentsWriter.reconcileOrphans(db, storage);
	if (reply.status !== "ok") throw Error(reply.error.code);
	return reply.value;
}

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
 * runs the existing workers, each of which returns expired leases to the queue first. It deletes the uploaded files that
 * failed or partial People imports kept for 7 days after they last stopped (`people-import-files`). Beside the queued
 * object cleanup (`object-cleanup`) it sweeps up to 20 stored files nothing references, such as an export or upload
 * whose write never finished (`documents-orphans`, skipped without private storage). Requested deletions whose
 * cancellation deadline has passed are purged on the cleanup login (`lifecycle_purge`). It queues the digests whose period
 * ended at the run's clock and delivers a bounded batch of them (WP-030), and writes the notices of due meeting
 * announcements and reminders (`notification`). The workers claim with SKIP
 * LOCKED, so ticks that overlap each other or a request's own drain never run one job twice. The schedule grants no
 * business authority: every worker rechecks its own fences and sources.
 *
 * Queued mail: before any send, `mail-expiry` cancels stale mail never handed off (a password-reset or verification
 * link older than the link, a reminder a day past its slot), so a backlog is never sent. Then mail goes out in one
 * pass per mount, each claiming only its own logical-key prefixes (`MAIL_PASSES` in mail.ts) and rechecking every mail
 * under that mount's own rule just before the handoff: church invitations (`mail`), identity (`identity-mail`),
 * organization connections (`organization-mail`), settings (`settings-mail`), onboarding and association receipts
 * (`onboarding-mail`), notice email from tasks, phases, meetings and milestones (`notice-mail`) and digests
 * (`digest-mail`). Each pass first replays its mail whose handoff answered unknown on an earlier tick, under the same
 * stored request and idempotency key, while the email service's 23 h 55 min window holds (`claimUnknownMail`).
 * Scheduled Messages email goes through `messages`. Last, `mail-callbacks` applies stored provider callbacks whose
 * email now has its provider id (`replayStoredCallbacks`).
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
	/** The ports an approved Evry effect needs (task reminders, phase notices); null without them, and effects wait. */
	effects: EffectPorts | null;
	/** Sends one bounded batch of due invitation mail; null when the deployment has no mail transport. */
	mail: ((limit: number, until: number) => Promise<number>) | null;
	/**
	 * Hands due scheduled Messages email to the email service at its send time, checking opt-outs then, and cancels
	 * emails the email service already holds for people who unsubscribed (T-241). Null without mail configuration.
	 */
	messages?: ((limit: number, until: number) => Promise<number>) | null;
	/**
	 * The other mounts' mail passes, each sending one bounded batch of its own due mail. Each is null when the
	 * deployment has no mail configuration or none for that mount; a missing one is skipped.
	 */
	mountMail?: Partial<Record<Exclude<MailPassName, "mail">, MailPass | null>>;
	/** Null on a deployment without mail configuration: no digest is planned or delivered there. */
	digests: DigestWorker | null;
	/** Writes the notices of due meeting announcement and reminder jobs; null without mail configuration. */
	notifications?: NotificationWorker | null;
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
		const { storage, cleanup, effects, digests, mail } = config;
		const messages = config.messages ?? null;
		const notifications = config.notifications ?? null;
		const pass = (name: keyof NonNullable<typeof config.mountMail>): Step => {
			const run = config.mountMail?.[name] ?? null;
			return [`${name}-mail`, null, run && (() => run(20, until))];
		};
		const steps: Step[] = [
			["close-lost-jobs", "closed", () => transaction(db, (tx) => closeLostJobs(tx))],
			["people-import", null, () => runDueImports(db, 4, until)],
			["people-import-files", null, () => deleteExpiredImportFiles(db)],
			["object-cleanup", "removed", storage && (() => runDueObjectCleanup(db, storage, 4, until))],
			["documents-orphans", null, storage && (() => sweepOrphans(db, storage))],
			["lifecycle-purge", "purged", cleanup && storage && (() => runDuePurges(db, cleanup, storage, 2, until))],
			["evry-effect", "effects", effects && (() => runEffects(db, effects, 4, until))],
			["assistant-turn", "turns", () => runTurns(db, 4, until)],
			["digest-planning", "planned", digests && (() => planDigests(db, asOf))],
			["digest-delivery", "digests", digests && (() => digests.run(db, asOf, undefined, until))],
			["notification", "notified", notifications && (() => notifications.run(db, asOf, undefined, until))],
			["mail-expiry", null, () => expireStaleMail(db)],
			["mail", "mailed", mail && (() => mail(20, until))],
			pass("identity"),
			pass("organization"),
			pass("settings"),
			pass("onboarding"),
			pass("notice"),
			pass("digest"),
			["messages", "messages", messages && (() => messages(20, until))],
			["mail-callbacks", null, () => replayStoredCallbacks(db)],
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
			notified: 0,
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
