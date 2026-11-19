import { instant } from "@everyfield/contracts/common";
import type { Database } from "@everyfield/db/client";
import type { PrivateStorage } from "@everyfield/db/schema";
import { documentsWriter } from "@everyfield/domain/documents";
import { createAssessmentJob, runAssessmentBatch, type Drafter } from "@everyfield/domain/intelligence";
import { deleteExpiredImportFiles } from "@everyfield/domain/people";
import type { TaskReminders } from "@everyfield/domain/tasks";
import { closeLostJobs } from "@everyfield/evry";
import {
	cancelUnsubscribedHeld,
	runDueScheduled,
	type DeliveryKeys,
	type DeliveryTransport,
} from "@everyfield/domain/communication";
import "server-only";
import { runEffects, runTurns } from "../evry/worker.ts";
import { runDueImports } from "../../features/people/import-export/run-imports.ts";
import { cronRoute } from "../platform/cron.ts";
import { transaction } from "../platform/database.ts";
import { planDigests, type DigestWorker } from "./digest.ts";
import { runDuePurges } from "./lifecycle-purge.ts";
import { expireStaleMail, type MailPass, type MailPassName } from "./mail.ts";
import type { NotificationWorker } from "../../features/notifications/worker.ts";
import { runDueObjectCleanup } from "./object-cleanup.ts";
import { replayStoredCallbacks } from "./webhook.ts";

const START_MS = 60_000;

type StepStatus = { status: "ok"; count: unknown } | { status: "skipped" } | { status: "failed" };
type Step = readonly [component: string, key: string | null, run: (() => Promise<unknown>) | null];

async function sweepOrphans(db: Database, storage: PrivateStorage) {
	const reply = await documentsWriter.reconcileOrphans(db, storage);
	if (reply.status !== "ok") throw Error(reply.error.code);
	return reply.value;
}

export function scheduledMessages(db: Database, transport: DeliveryTransport, keys: DeliveryKeys) {
	return async (limit: number, until: number) =>
		(await cancelUnsubscribedHeld(db, transport, 50)) + (await runDueScheduled(db, transport, keys, limit, until));
}

export function scheduledJobs(config: {
	secret: string | undefined;
	db: Database | null;
	storage: PrivateStorage | null;
	cleanup: Database | null;
	reminders: TaskReminders | null;
	mail: ((limit: number, until: number) => Promise<number>) | null;
	messages?: ((limit: number, until: number) => Promise<number>) | null;
	mountMail?: Partial<Record<Exclude<MailPassName, "mail">, MailPass | null>>;
	digests: DigestWorker | null;
	notifications?: NotificationWorker | null;
	feedbackPublication?: ((limit: number, until: number) => Promise<number>) | null;
	assessments?: { drafter: Drafter } | null;
	now?: () => Date;
}) {
	return cronRoute(config.secret, async () => {
		const db = config.db;
		if (!db) return Response.json({ status: "unavailable" }, { status: 503 });
		const until = Date.now() + START_MS;
		const asOf = (config.now?.() ?? new Date()).toISOString();
		const { storage, cleanup, reminders, digests, mail } = config;
		const messages = config.messages ?? null;
		const notifications = config.notifications ?? null;
		const feedbackPublication = config.feedbackPublication ?? null;
		const assessments = config.assessments ?? null;
		const now = config.now;
		const assessing = createAssessmentJob(now ? { clock: { now: () => instant.parse(now().toISOString()) } } : {});
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
			["evry-effect", "effects", reminders && (() => runEffects(db, reminders, 4, until))],
			["assistant-turn", "turns", () => runTurns(db, 4, until)],
			["digest-planning", "planned", digests && (() => planDigests(db, asOf))],
			["digest-delivery", "digests", digests && (() => digests.run(db, asOf, undefined, until))],
			["notification", "notified", notifications && (() => notifications.run(db, asOf, undefined, until))],
			["assessment-demand", null, assessments && (() => assessing.scheduleAssessments(db))],
			["assessment", null, assessments && (() => runAssessmentBatch(assessing, db, assessments.drafter, 2, until))],
			["feedback-publication", null, feedbackPublication && (() => feedbackPublication(10, until))],
			["mail-expiry", null, () => expireStaleMail(db)],
			["mail", "mailed", mail && (() => mail(20, until))],
			pass("identity"),
			pass("organization"),
			pass("settings"),
			pass("onboarding"),
			pass("notice"),
			pass("digest"),
			pass("feedback"),
			["messages", "messages", messages && (() => messages(20, until))],
			["mail-callbacks", null, () => replayStoredCallbacks(db)],
		];
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
				console.error(JSON.stringify({ component, runner: "scheduled-jobs", outcome: "error" }));
				report[component] = { status: "failed" };
			}
		}
		const failed = Object.keys(report).filter((component) => report[component]!.status === "failed");
		return Response.json(
			{ status: failed.length ? "failed" : "ok", ...counts, failed, steps: report },
			{ status: failed.length ? 500 : 200 },
		);
	});
}
