import { instant } from "@everyfield/contracts/common";
import type { Database } from "@everyfield/db/client";
import type { PrivateStorage } from "@everyfield/db/schema";
import { documentsWriter } from "@everyfield/domain/documents";
import { createAssessmentJob, createRelease, runAssessmentBatch, type Drafter } from "@everyfield/domain/intelligence";
import { runIntelligenceRefreshBatch, scheduleIntelligenceRefresh } from "@everyfield/domain/oversight";
import { deleteExpiredImportFiles } from "@everyfield/domain/people";
import { closeLostJobs, type EffectPorts } from "@everyfield/evry";
import {
	cancelUnsubscribedHeld,
	runDueScheduled,
	type DeliveryKeys,
	type DeliveryTransport,
} from "@everyfield/domain/communication";
import "server-only";
import { runEffects, runTurns } from "../evry/worker.ts";
import { runDueImports } from "../../features/people/import-export/run-imports.ts";
import {
	transaction,
	runDuePurges,
	runDueObjectCleanup,
	expireStaleMail,
	type MailPass,
	type MailPassName,
	replayStoredCallbacks,
	planDigests,
	type DigestWorker,
} from "@everyfield/domain/jobs";
import type { NotificationWorker } from "../../features/notifications/worker.ts";
import { asLogWord, logLine } from "@everyfield/domain/log";
import { readSwitches, switchedOff, type KillSwitch } from "@everyfield/domain/flags";

const START_MS = 60_000;

type StepStatus =
	{ status: "ok"; count: unknown } | { status: "skipped" } | { status: "paused" } | { status: "failed" };
type Run = () => Promise<unknown>;
type Step = readonly [component: string, key: string | null, run: Run | null | { paused: KillSwitch }];

async function sweepOrphans(db: Database, storage: PrivateStorage) {
	const reply = await documentsWriter.reconcileOrphans(db, storage);
	if (reply.status !== "ok") throw Error(reply.error.code);
	return reply.value;
}

export function scheduledMessages(db: Database, transport: DeliveryTransport, keys: DeliveryKeys) {
	return (limit: number, until: number) => runDueScheduled(db, transport, keys, limit, until);
}

export function unsubscribedCancels(db: Database, transport: DeliveryTransport) {
	return () => cancelUnsubscribedHeld(db, transport, 50);
}

export function scheduledJobs(config: {
	db: Database;
	storage: PrivateStorage | null;
	cleanup: Database | null;
	effects: EffectPorts | null;
	mail: ((limit: number, until: number) => Promise<number>) | null;
	messages?: ((limit: number, until: number) => Promise<number>) | null;
	messageCancels?: (() => Promise<number>) | null;
	mountMail?: Partial<Record<Exclude<MailPassName, "mail">, MailPass | null>>;
	digests: DigestWorker | null;
	notifications?: NotificationWorker | null;
	feedbackPublication?: ((limit: number, until: number) => Promise<number>) | null;
	wikiEmbedding?: ((limit: number, until: number) => Promise<number>) | null;
	assessments?: { drafter: Drafter } | null;
	now?: () => Date;
}) {
	return async (): Promise<Response> => {
		const db = config.db;
		const until = Date.now() + START_MS;
		const asOf = (config.now?.() ?? new Date()).toISOString();
		const { storage, cleanup, effects, digests, mail } = config;
		const messages = config.messages ?? null;
		const notifications = config.notifications ?? null;
		const feedbackPublication = config.feedbackPublication ?? null;
		const wikiEmbedding = config.wikiEmbedding ?? null;
		const assessments = config.assessments ?? null;
		const now = config.now;
		const clock = now ? { clock: { now: () => instant.parse(now().toISOString()) } } : {};
		const assessing = createAssessmentJob(clock);
		const releasing = createRelease(clock);
		const switches = await readSwitches(db);
		const held = (name: KillSwitch, run: Run | null) => (run && !switches[name] ? { paused: name } : run);
		const mailing = (run: Run | null) => held("outbound-mail", run);
		const pass = (name: keyof NonNullable<typeof config.mountMail>): Step => {
			const run = config.mountMail?.[name] ?? null;
			return [`${name}-mail`, null, mailing(run && (() => run(20, until)))];
		};
		const steps: Step[] = [
			["close-lost-jobs", "closed", () => transaction(db, (tx) => closeLostJobs(tx))],
			["people-import", null, () => runDueImports(db, 4, until)],
			["people-import-files", null, () => deleteExpiredImportFiles(db)],
			["object-cleanup", "removed", storage && (() => runDueObjectCleanup(db, storage, 4, until))],
			["documents-orphans", null, storage && (() => sweepOrphans(db, storage))],
			["lifecycle-purge", "purged", cleanup && storage && (() => runDuePurges(db, cleanup, storage, 2, until))],
			["evry-effect", "effects", effects && (() => runEffects(db, switches, effects, 4, until))],
			["assistant-turn", "turns", () => runTurns(db, switches, 4, until)],
			["digest-planning", "planned", digests && (() => planDigests(db, asOf))],
			["digest-delivery", "digests", digests && (() => digests.run(db, asOf, undefined, until))],
			["notification", "notified", notifications && (() => notifications.run(db, asOf, undefined, until))],
			["assessment-release", null, () => releasing.releaseDueAssessments(db)],
			["assessment-demand", null, assessments && (() => assessing.scheduleAssessments(db))],
			[
				"assessment",
				null,
				held(
					"evry-model-calls",
					assessments && (() => runAssessmentBatch(assessing, db, assessments.drafter, 2, until)),
				),
			],
			["network-intelligence-demand", null, async () => (await scheduleIntelligenceRefresh(db)).length],
			["network-intelligence", null, () => runIntelligenceRefreshBatch(db)],
			["feedback-publication", null, feedbackPublication && (() => feedbackPublication(10, until))],
			["wiki-embedding", null, wikiEmbedding && (() => wikiEmbedding(10, until))],
			["mail-expiry", null, () => expireStaleMail(db)],
			["mail", "mailed", mailing(mail && (() => mail(20, until)))],
			pass("identity"),
			pass("organization"),
			pass("settings"),
			pass("onboarding"),
			pass("notice"),
			pass("digest"),
			pass("feedback"),
			["message-cancels", null, config.messageCancels ?? null],
			["messages", "messages", mailing(messages && (() => messages(20, until)))],
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
			if (typeof run !== "function") {
				switchedOff(switches, run.paused, asLogWord(component));
				report[component] = { status: "paused" };
				continue;
			}
			try {
				const count = await run();
				report[component] = { status: "ok", count: count ?? null };
				if (key) counts[key] = count;
			} catch {
				logLine({ component: asLogWord(component), runner: "scheduled-jobs", outcome: "error" });
				report[component] = { status: "failed" };
			}
		}
		const failed = Object.entries(report).flatMap(([component, step]) => (step.status === "failed" ? [component] : []));
		return Response.json(
			{ status: failed.length ? "failed" : "ok", ...counts, failed, steps: report },
			{ status: failed.length ? 500 : 200 },
		);
	};
}
