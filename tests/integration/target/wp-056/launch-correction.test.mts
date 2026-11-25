import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "../../platform/setup.mts";
import { sql } from "../../../../packages/db/src/query.ts";
import { dayText } from "../../../../packages/contracts/src/common/index.ts";
import type { DebriefAnswers } from "../../../../packages/contracts/src/launch/index.ts";
import {
	authorizeLaunchNotices,
	createLaunchReader,
	createLaunchWriter,
} from "../../../../packages/domain/src/launch/index.ts";
import { createMailService } from "../../../../packages/domain/src/jobs/mail.ts";
import { seatedNotificationService } from "../../../../packages/domain/src/jobs/seated-notifications.ts";
import { dashboardReader } from "../../../../packages/domain/src/dashboard/index.ts";
import { phaseReader } from "../../../../packages/domain/src/phases/index.ts";
import { getPlant } from "../../../../packages/domain/src/oversight/index.ts";
import { launchNotices } from "../../../../apps/web/src/features/launch/notices.ts";
import { ok } from "../../../support/fixture.mts";
import { key, world, type Feature, type World } from "./corrections-world.mts";

let w: World;
before(async () => {
	w = await world("corrlaunch");
});
after(() => w?.database.close());

const BLANK: DebriefAnswers = {
	wentWell: null,
	toChange: null,
	operations: null,
	followUpPlan: null,
	supportNeeded: null,
	missingNames: null,
	missingCount: null,
};

test("INV-corrections: correcting a wrong Launch debrief answer and outcome moves the Launch plan, evidence, Plant Intelligence, shared oversight and Evry reads, keeps the old answers in history and rewrites no published summary", async () => {
	const { actor } = w.boss;
	const short = (n: number) => dayText(w.day(n), { year: "never" });
	const mail = createMailService({
		db: w.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "launch@example.test",
		authorize: authorizeLaunchNotices,
		transport: {
			async send() {
				return { kind: "accepted", id: key() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	const reader = createLaunchReader();
	const writer = createLaunchWriter({ notices: launchNotices(seatedNotificationService(mail)) });
	const plan = async () => ok(await reader.readPlan(w.db, actor)).plan;
	const pat = await w.person(w.p, "Pat Reader", { email: "pat@example.test" });
	ok(
		await writer.schedule(w.db, actor, {
			requestKey: key(),
			expectedRevision: "1",
			input: { date: w.day(-2), reason: null },
		}),
	);
	const recorded = { actualDate: w.day(-1), attendance: 40, decisions: 6, note: null };
	ok(
		await writer.recordOutcome(w.db, actor, {
			requestKey: key(),
			expectedRevision: (await plan()).revision,
			input: recorded,
		}),
	);
	const submit = async (answers: Partial<DebriefAnswers>) => {
		const { debrief } = await plan();
		ok(
			await writer.submitDebrief(w.db, actor, {
				requestKey: key(),
				expectedRevision: debrief!.draft?.revision ?? "0",
				input: { draftId: debrief!.draft?.id ?? null, answers: { ...BLANK, ...answers } },
			}),
		);
	};
	const wrong = { wentWell: "Doors opened on time", missingNames: "yes", missingCount: 3 } as const;
	await submit(wrong);
	ok(
		await writer.publishDebriefSummary(w.db, actor, {
			requestKey: key(),
			expectedRevision: "0",
			input: { draftId: null, body: "We launched with 40 people." },
		}),
	);
	const published = await w.publish({ personIds: [pat.id] });
	const unchanged = await w.freeze([
		"mail",
		"communication",
		"launch_summary",
		"assessment_run",
		"network_intelligence_run",
		"network_intelligence_plant",
		"audit_event",
	]);
	const oversight = async () => (await getPlant(w.db, w.director, w.p.id))!;
	const features: Feature[] = [
		{
			name: "the Launch plan's submitted answers",
			read: async () => {
				const { submitted } = (await plan()).debrief!;
				return [submitted?.version, submitted?.answers.missingNames, submitted?.answers.missingCount];
			},
			before: [1, "yes", 3],
			after: [2, "no", null],
		},
		{
			name: "the Launch plan's outcome",
			read: async () => {
				const { outcome } = await plan();
				return [outcome?.actualDate, outcome?.attendance, outcome?.decisions];
			},
			before: [w.day(-1), 40, 6],
			after: [w.day(-2), 50, 6],
		},
		{
			name: "the Launch evidence and milestones",
			read: async () => {
				const p = await plan();
				return [
					p.evidence.guestNamesEntered,
					p.evidence.debriefDone,
					p.milestones.filter((m) => m.completion !== null).map((m) => m.title),
				];
			},
			before: [{ status: "not_met", remaining: 3 }, { status: "met" }, []],
			after: [{ status: "met", remaining: null }, { status: "met" }, []],
		},
		{
			name: "the phase journey",
			read: async () =>
				ok(await phaseReader.readHistory(w.db, actor)).entries.flatMap((e) =>
					e.kind === "launch_sunday" ? [e.actualDate] : [],
				),
			before: [w.day(-1)],
			after: [w.day(-2)],
		},
		{
			name: "Plant Intelligence facts",
			read: async () => {
				const f = await w.factsNow();
				return [f.firstService, f.criteria.first_service_complete];
			},
			before: [{ path: "launch_sunday", status: "met", heldOn: w.day(-1) }, "met"],
			after: [{ path: "launch_sunday", status: "met", heldOn: w.day(-2) }, "met"],
		},
		{
			name: "Plant Intelligence freshness",
			read: async () => (await w.stale()) === published.run.runId,
			before: false,
			after: true,
		},
		{
			name: "the shared oversight view",
			read: async () => (await oversight()).launch,
			before: {
				status: "shared",
				state: "completed",
				plannedDate: w.day(-2),
				milestones: { completed: 0, total: 9 },
				outcome: { actualDate: w.day(-1), attendance: 40, decisions: 6 },
				preparation: { launched: true, daysToLaunch: null, unfilledRoles: null, outstandingTraining: null },
			},
			after: {
				status: "shared",
				state: "completed",
				plannedDate: w.day(-2),
				milestones: { completed: 0, total: 9 },
				outcome: { actualDate: w.day(-2), attendance: 50, decisions: 6 },
				preparation: { launched: true, daysToLaunch: null, unfilledRoles: null, outstandingTraining: null },
			},
		},
		{
			name: "the published summary, which stays as published",
			read: async () => {
				const { summary } = await oversight();
				return [summary?.version, summary?.body];
			},
			before: [1, "We launched with 40 people."],
			after: [1, "We launched with 40 people."],
		},
		{
			name: "the dashboard activity",
			read: async () =>
				ok(await dashboardReader.readActivity(w.db, actor)).entries.flatMap((e) =>
					e.change.kind === "launch_recorded" || e.change.kind === "launch_corrected"
						? [[e.change.kind, e.change.date]]
						: [],
				),
			before: [["launch_recorded", w.day(-1)]],
			after: [
				["launch_corrected", w.day(-2)],
				["launch_recorded", w.day(-1)],
			],
		},
		{
			name: "Evry: the debrief",
			read: async () => {
				const { facts } = await w.evry("launch.readDebrief");
				return [facts?.attendance, facts?.decisions, facts?.guestsNotNamed, facts?.debrief, facts?.summaryPublished];
			},
			before: [40, 6, 3, "submitted", "We launched with 40 people."],
			after: [50, 6, 0, "submitted", "We launched with 40 people."],
		},
		{
			name: "Evry: the first service criterion",
			read: async () =>
				(await w.shown("intelligence.readExitCriteria", { phase: 5 }, ["status", "reading"])).filter(
					([label]) => label === "First service held",
				),
			before: [["First service held", "met", `Launch Sunday held on ${w.day(-1)}`]],
			after: [["First service held", "met", `Launch Sunday held on ${w.day(-2)}`]],
		},
		{
			name: "Evry: the dashboard activity",
			read: async () =>
				(await w.shown("dashboard.activity", {}, ["change"])).filter(([, c]) => String(c).startsWith("launch_")),
			before: [
				[`Launch Sunday recorded as held ${short(-1)}`, "launch_recorded"],
				[`Launch Sunday set for ${short(-2)}`, "launch_date"],
			],
			after: [
				[`Launch Sunday corrected to ${short(-2)}`, "launch_corrected"],
				[`Launch Sunday recorded as held ${short(-1)}`, "launch_recorded"],
				[`Launch Sunday set for ${short(-2)}`, "launch_date"],
			],
		},
		{
			name: "Evry: the phase journey",
			read: () => w.shown("phases.readHistory", {}, ["entry", "on"]),
			before: [
				["Core Group Development", null, null],
				["Launch Sunday", "launch_sunday", w.day(-1)],
			],
			after: [
				["Core Group Development", null, null],
				["Launch Sunday", "launch_sunday", w.day(-2)],
			],
		},
		{
			name: "Evry: the oversight view",
			read: () => w.shown("oversight.getPlant", { plantId: w.p.id }, ["launch", "publishedSummary"], w.director),
			before: [["Grace Harbor", "Launched", "We launched with 40 people."]],
			after: [["Grace Harbor", "Launched", "We launched with 40 people."]],
		},
	];
	await w.check(features, "before");

	await submit({ ...wrong, missingNames: "no", missingCount: null });
	ok(
		await writer.correctOutcome(w.db, actor, {
			requestKey: key(),
			expectedRevision: (await plan()).revision,
			input: { ...recorded, actualDate: w.day(-2), attendance: 50, reason: "Counted the nursery" },
		}),
	);

	await w.check(features, "after");
	const { entries } = ok(await reader.readJournal(w.db, actor));
	assert.deepEqual(
		entries.slice(0, 4).map((e) => [e.actor?.displayName, e.change]),
		[
			[
				"Adam Admin",
				{
					kind: "outcome",
					event: "corrected",
					changes: [
						{ field: "actualDate", before: w.day(-1), after: w.day(-2) },
						{ field: "attendance", before: 40, after: 50 },
					],
					reason: "Counted the nursery",
				},
			],
			["Adam Admin", { kind: "debrief", event: "corrected", version: 2 }],
			["Adam Admin", { kind: "summary", version: 1 }],
			["Adam Admin", { kind: "debrief", event: "submitted", version: 1 }],
		],
	);
	assert.deepEqual(
		await w.rows(sql`SELECT version,missing_names AS answer,missing_count AS count,submitted_by AS by FROM launch_debrief
			WHERE plant_id=${w.p.id} ORDER BY version`),
		[
			{ version: 1, answer: "yes", count: 3, by: w.boss.id },
			{ version: 2, answer: "no", count: null, by: w.boss.id },
		],
	);
	assert.deepEqual(await w.auditOf(sql`action='launch.corrected'`), [
		{
			actor_id: w.boss.id,
			before: { version: 1, missingCount: 3, missingNames: "yes" },
			after: { version: 2, missingCount: null, missingNames: "no" },
			reason: null,
			recent: true,
		},
		{
			actor_id: w.boss.id,
			before: { actualDate: w.day(-1), attendance: 40 },
			after: { actualDate: w.day(-2), attendance: 50 },
			reason: "Counted the nursery",
			recent: true,
		},
	]);
	assert.deepEqual((await w.shown("launch.readJournal", {}, ["fields", "reason", "by"])).slice(0, 2), [
		["Launch Sunday corrected", "actualDate, attendance", "Counted the nursery", "Adam Admin"],
		["Debrief corrected (version 2)", null, null, "Adam Admin"],
	]);
	await unchanged();
});
