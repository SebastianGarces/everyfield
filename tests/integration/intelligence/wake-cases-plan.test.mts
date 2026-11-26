import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantId } from "../../../packages/contracts/src/common/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { createFollowUpWriter, withFollowUpWrite } from "../../../packages/domain/src/followups/index.ts";
import { createSeatService } from "../../../packages/domain/src/identity/seats.ts";
import {
	ASSESSMENT_TIMING,
	createAssessmentJob,
	createRelease,
	createSignals,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import { createLaunchReader, createLaunchWriter } from "../../../packages/domain/src/launch/index.ts";
import { createPhaseWriter } from "../../../packages/domain/src/phases/writes.ts";
import { phaseReader } from "../../../packages/domain/src/phases/reads.ts";
import { eligibleOwner } from "../../../packages/domain/src/tasks/owner.ts";
import { nativeFromText, nativeText, readNative } from "../../../packages/contracts/src/documents/native.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import {
	createOrganizationAdapter,
	geographyReference,
	installGeographyRelease,
	readReportingLocation,
	suggestRegions,
} from "../../../packages/domain/src/organizations/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import {
	claimIntelligenceRefresh,
	readIntelligence,
	runIntelligenceRefresh,
	scheduleIntelligenceRefresh,
} from "../../../packages/domain/src/oversight/intelligence.ts";
import { getPlant, listPlants } from "../../../packages/domain/src/oversight/index.ts";
import { sharingOperations } from "../../../packages/domain/src/organizations/sharing.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import foundations from "../../../docs/reference/discovery-foundations.json" with { type: "json" };
import { validateBundle } from "../../../packages/reference/src/index.ts";
import { ok } from "../../support/fixture.mts";
import { fixture } from "../../reference/releases/fixtures.mts";
import { promotions } from "../../reference/releases/promotions.mts";
import { CANARY } from "./assessment-church.mts";
import {
	listed,
	row,
	strip,
	wakeCase,
	wakeWorld,
	type LoadedWakeCase,
	type Row,
	type WakeOrg,
	type WakePlant,
	type WakeWorld,
} from "./wake-world.mts";

let W: WakeWorld;
let dbClock: { now: () => never };
before(async () => {
	W = await wakeWorld("mw2");
	await installGeographyRelease(W.c.admin);
	dbClock = W.clock;
});
after(() => W?.close());

type Json = Record<string, unknown>;

const pick = (all: Json, keys: unknown) => Object.fromEntries(Object.keys(keys as Json).map((key) => [key, all[key]]));
const iso = (at: string | Date | null) => (at === null ? null : new Date(at).toISOString().replace(".000Z", "Z"));
const DAY = 86_400_000;
const record = (id: string, kind: string, tenant: string) =>
	W.c.admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${id},${kind},${tenant}) ON CONFLICT DO NOTHING`);

async function followUp(w: { P: { id: string } }, person: { id: string }, assignee: string | null) {
	const meeting = await W.c.vision(w.P as never, 3, [person]);
	const obligation = randomUUID(),
		task = randomUUID();
	await record(obligation, "obligation", w.P.id);
	await record(task, "task", w.P.id);
	await W.c.admin
		.execute(sql`INSERT INTO obligation(id,plant_id,meeting_id,person_id,kind,origin_at,origin_date,timezone,
		formula_version,due_date) VALUES(${obligation},${w.P.id},${meeting},${person.id},'follow_up',
		clock_timestamp()-interval '72 hours',${W.c.day(-3)},'America/Chicago','f1',${W.c.day(-1)})`);
	await W.c.admin
		.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,obligation_id,
		person_id) VALUES(${task},${w.P.id},'Call the guest','follow_up','medium','not_started',
		clock_timestamp()-interval '72 hours','undated',${obligation},${person.id})`);
	if (assignee)
		await W.c.admin.execute(
			sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${w.P.id},${task},${assignee})`,
		);
	return { obligation, task };
}

const followups = createFollowUpWriter({ reminders: (async () => {}) as never });
const signals = () => createSignals({ clock: dbClock });
const phases = () => createPhaseWriter({ notices: async () => {} });
const launch = () => ({
	reader: createLaunchReader(dbClock),
	writer: createLaunchWriter({ notices: async () => undefined, clock: dbClock }),
});

const ROWS: Row<unknown>[] = [
	row({
		id: "MW-CASE-014",
		marker: "AC:MW-CASE-014 ",
		operation: "followups.recordOutcome",
		producer:
			"createFollowUpWriter().recordOutcome on the obligation's task (contacted, occurredAt, completeTask false); the earlier contact is a standalone person contact",
		arrange: async (w, k) => {
			const before = k.given["input-before"] as { effectiveContactedAt: string };
			const person = await W.c.person(w.P, "Person P");
			const { task } = await followUp(w, person, null);
			ok(
				await withFollowUpWrite(W.db, w.A.actor, (tx, ctx) =>
					followups.recordOutcome(tx, ctx, {
						requestKey: randomUUID(),
						input: {
							target: { kind: "person", personId: person.id },
							outcome: "contacted",
							occurredAt: before.effectiveContactedAt,
							completeTask: false,
						},
					}),
				),
			);
			return { person: person.id, task, done: false };
		},
		facts: async (w) => {
			const a = w.arranged as { person: string; done: boolean };
			const k = wakeCase("MW-CASE-014");
			const asOf = (k.given["input-before"] as { asOf: string }).asOf;
			const last = (
				await W.c.one<{ at: Date | null }>(sql`SELECT max(occurred_at) AS at FROM contact_outcome
					WHERE plant_id=${w.P.id} AND person_id=${a.person} AND voided_at IS NULL AND outcome='contacted'`)
			).at;
			const all = {
				effectiveContactedAt: iso(last),
				asOf,
				strictlyUnder14Days: last !== null && Date.parse(asOf) - new Date(last).getTime() < 14 * DAY,
			};
			return pick(all, a.done ? (k.expected.result as Json).facts! : (k.failure.expected.state as Json).facts!);
		},
		write: async (w, k) => {
			const a = w.arranged as { task: string; done: boolean; revision?: string };
			const args = k.action.arguments as { outcome: string; occurredAt: string; notes: null };
			a.revision ??= (
				await W.c.one<{ revision: string }>(sql`SELECT revision::text AS revision FROM task WHERE id=${a.task}`)
			).revision;
			const reply = await withFollowUpWrite(W.db, w.A.actor, (tx, ctx) =>
				followups.recordOutcome(tx, ctx, {
					requestKey: W.key(String(k.action.arguments.request_key)),
					input: {
						target: { kind: "task", taskId: a.task, expectedRevision: a.revision },
						outcome: args.outcome,
						occurredAt: args.occurredAt,
						notes: args.notes,
						completeTask: false,
					},
				}),
			);
			if (reply.status === "ok") a.done = true;
			return reply;
		},
		action: "followup.recorded",
	}),
	row({
		id: "MW-CASE-015",
		marker: "AC:MW-CASE-015 ",
		operation: "phases.transition",
		producer: "createPhaseWriter().transition (toPhase, reason, expectedRevision = the reviewed plant revision)",
		arrange: async (w) => {
			const op = randomUUID(),
				id = randomUUID();
			await W.c.admin.execute(sql`INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_type,subject_id)
				VALUES(${op},${w.P.id},${w.P.owner.id},'phase.created','create','plant',${w.P.id})`);
			await record(id, "phase_transition", w.P.id);
			await W.c.admin.execute(sql`INSERT INTO phase_transition(id,plant_id,kind,from_phase,to_phase,reason,occurred_at,
				recorded_at,operation_id) VALUES(${id},${w.P.id},'creation',NULL,1,'Plant created in Everyfield.',
				clock_timestamp()-interval '30 days',clock_timestamp()-interval '30 days',${op})`);
			const { revision } = await W.c.one<{ revision: string }>(
				sql`SELECT revision::text AS revision FROM plant WHERE id=${w.P.id}`,
			);
			return { revision };
		},
		facts: async (w) => {
			const history = ok(await phaseReader.readHistory(W.db, w.A.actor));
			const entries = history.entries.filter((e) => e.kind !== "launch_sunday" && e.kind !== "gathering");
			const last = entries.at(-1)!;
			return last.kind === "movement"
				? {
						phase: history.state.phase,
						phaseHistoryCount: entries.length,
						direction: last.direction === "forward" ? "advance" : last.direction,
					}
				: {
						phase: history.state.phase,
						phaseHistoryCount: entries.length,
						creationEntry: last.kind === "creation" && last.toPhase === 1 ? "created_into_phase1" : last.kind,
					};
		},
		write: async (w, k) => {
			const a = w.arranged as { revision: string };
			const args = k.action.arguments as { toPhase: number; reason: string };
			return phases().transition(W.db, w.A.actor, {
				requestKey: W.key(String(k.action.arguments.request_key)),
				expectedRevision: a.revision,
				input: { toPhase: args.toPhase, reason: args.reason },
			});
		},
	}),
	row({
		id: "MW-CASE-016",
		marker: "AC:MW-CASE-016 ",
		operation: "signals.attest",
		producer:
			"createSignals().correct (action correct, value yes, asOf = actualEvidenceDate) on prayer_rhythm_established answered not yet as of 2026-09-01",
		arrange: async (w, k) => {
			const before = k.given["input-before"] as Record<string, string>;
			const answered = {
				prayer_rhythm_established: before.prayerRhythmEvidenceDate,
				core_group_giving: before.givingEvidenceDate,
				prayer_in_gatherings: before.prayerInGatheringsDate,
			};
			for (const [key, asOf] of Object.entries(answered))
				ok(
					await signals().attest(W.db, w.A.actor, {
						requestKey: randomUUID(),
						expectedRevision: "0",
						input: { key, value: key === "prayer_rhythm_established" ? "not_yet" : "yes", asOf },
					}),
				);
			return { revision: null as string | null };
		},
		facts: async (w) => {
			const page = ok(await signals().readAttestations(W.db, w.A.actor, {}));
			const asOf = (key: string) =>
				(page.signals.find((s) => s.key === key) as { asOf?: string | null } | undefined)?.asOf ?? null;
			return {
				prayerRhythmEvidenceDate: asOf("prayer_rhythm_established"),
				givingEvidenceDate: asOf("core_group_giving"),
				prayerInGatheringsDate: asOf("prayer_in_gatherings"),
			};
		},
		write: async (w, k) => {
			const a = w.arranged as { revision: string | null };
			const evidence = (
				k.action.arguments as { evidence: { signalKey: string; answer: boolean; actualEvidenceDate: string } }
			).evidence;
			if (a.revision === null) {
				const page = ok(await signals().readAttestations(W.db, w.A.actor, {}));
				a.revision = (page.signals.find((s) => s.key === evidence.signalKey) as { revision: string }).revision;
			}
			return signals().correct(W.db, w.A.actor, {
				requestKey: W.key(String(k.action.arguments.request_key)),
				expectedRevision: a.revision,
				input: {
					action: "correct",
					key: evidence.signalKey,
					value: evidence.answer ? "yes" : "not_yet",
					asOf: evidence.actualEvidenceDate,
				},
			});
		},
	}),
	row({
		id: "MW-CASE-019",
		marker: "AC:MW-CASE-019 ",
		operation: "launch.schedule",
		producer: "createLaunchWriter().schedule (first schedule: expectedRevision 1, date = plannedLocalDate)",
		arrange: async (w, k) => {
			const before = k.given["input-before"] as { phase: number };
			await W.c.admin.execute(sql`UPDATE plant SET phase=${before.phase} WHERE id=${w.P.id}`);
			return { done: false };
		},
		facts: async (w) => {
			const a = w.arranged as { done: boolean };
			const k = wakeCase("MW-CASE-019");
			const plan = ok(await launch().reader.readPlan(W.db, w.A.actor)).plan;
			const tasks = plan.milestones.flatMap((m) => m.tasks);
			const { phase } = await W.c.one<{ phase: number }>(sql`SELECT phase FROM plant WHERE id=${w.P.id}`);
			const all = {
				launchExists: plan.launch !== null && plan.launch.status !== "planning",
				phase,
				milestoneCount: plan.milestones.length,
				taskCount: tasks.length,
				initialTaskDueDates: tasks.map((t) => (t as { dueDate?: string | null }).dueDate ?? null),
			};
			return pick(all, a.done ? (k.expected.result as Json).facts! : (k.failure.expected.state as Json).facts!);
		},
		write: async (w, k) => {
			const a = w.arranged as { done: boolean };
			const args = k.action.arguments as { plannedLocalDate: string };
			const reply = await launch().writer.schedule(W.db, w.A.actor, {
				requestKey: W.key(String(k.action.arguments.request_key)),
				expectedRevision: "1",
				input: { date: args.plannedLocalDate, reason: null },
			});
			if (reply.status === "ok") a.done = true;
			return reply;
		},
	}),
	row({
		id: "MW-CASE-023",
		marker: "AC:MW-CASE-023 ",
		operation: "seats.remove",
		producer:
			"createSeatService().remove with the readRemoval review (expectedRole, needs_owner handoffs) for Seat-B, a non-owner Admin linked to the Discovery lead",
		arrange: async (w) => {
			const b = await W.c.database.actor(w.P, "admin");
			const seatId = (
				await W.c.one<{ id: string }>(sql`SELECT id FROM seat WHERE account_id=${b.id} AND plant_id=${w.P.id}`)
			).id;
			const leader = randomUUID();
			await W.c.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,
				adult_classification,commitment_state,pipeline_position,state,created_at,linked_account_id)
				VALUES(${leader},${w.P.id},${w.P.id},'Casey Leader',${randomUUID() + "@example.test"},'other','leader','adult',
				'unknown','1','live',clock_timestamp(),${b.id})`);
			const contact = await W.c.person(w.P, "Alex Contact");
			const { task } = await followUp(w, contact, b.id);
			return { account: b.id, seatId, leader, task, cmd: null as unknown };
		},
		facts: async (w) => {
			const a = w.arranged as { account: string; seatId: string; leader: string };
			const seat = await W.c.one<{ role: string; ended_at: Date | null }>(
				sql`SELECT role,ended_at FROM seat WHERE id=${a.seatId}`,
			);
			const eligible = await W.c.one<{ ok: boolean }>(
				sql`SELECT ${eligibleOwner(sql`${a.account}::uuid`, sql`${w.P.id}::uuid`)} AS ok`,
			);
			const lead = await W.c.one<{ ok: boolean }>(sql`SELECT EXISTS(SELECT FROM person e JOIN seat x
				ON x.account_id=e.linked_account_id AND x.plant_id=e.plant_id AND x.role='admin' AND x.ended_at IS NULL
				WHERE e.id=${a.leader} AND e.state='live') AS ok`);
			return {
				seatRole: seat.ended_at === null ? seat.role : "removed",
				eligibleTaskOwner: eligible.ok,
				DiscoveryLinkedLeadAdmin: lead.ok,
			};
		},
		write: async (w, k) => {
			const a = w.arranged as { seatId: string; task: string; cmd: unknown };
			const owner = { kind: "plant" as const, id: tenantId.parse(w.P.id) };
			const seats = createSeatService(W.db);
			if (!a.cmd) {
				const review = await seats.readRemoval(w.A.session, owner, { seatId: a.seatId });
				assert.deepEqual(
					review.duties.map((d) => d.dutyId),
					[a.task],
				);
				a.cmd = {
					input: {
						seatId: review.seatId,
						expectedRole: review.expectedRole,
						handoffs: review.duties.map((d) => ({
							kind: "needs_owner",
							dutyId: d.dutyId,
							expectedRevision: d.expectedRevision,
						})),
					},
					expectedRevision: review.expectedRevision,
					requestKey: W.key(String(k.action.arguments.request_key)),
				};
			}
			return seats.remove(w.A.actor, owner, a.cmd as never, async () => {});
		},
		action: "membership.ended",
	}),
];

for (const r of ROWS)
	test(`${r.marker}${r.operation} fails all or nothing with the wakeup paused: the change is found by the sweep, a replay adds nothing and stale publications are superseded`, async () => {
		assert.equal(r.marker, `AC:${r.id} `);
		const k = wakeCase(r.id);
		assert.equal(k.action.operation, r.operation);
		assert.equal(k.replay.action.operation, r.operation);
		assert.equal(k.failure.action.operation, r.operation);
		const w = await W.plant(r.id, (base) => r.arrange(base, k));
		const facts = () => r.facts(w);
		assert.deepEqual(await facts(), strip(k.given["input-before"] as Json));
		await W.runCase(w, k, { write: () => r.write(w, k), facts, action: r.action });
	});

const wiki = createWikiProducer();
const organizations = createOrganizationAdapter(
	{ async invitation() {}, invalidate: () => sql`UPDATE job SET state=state WHERE false` } as never,
	geographyReference,
);
const COACH = "5e8e4b82-905a-4110-ac3a-a45cb0155365";
const BLANK = {
	wentWell: null,
	toChange: null,
	operations: null,
	followUpPlan: null,
	supportNeeded: null,
	missingNames: null,
	missingCount: null,
};
const WRITTEN = ["wentWell", "toChange", "operations", "followUpPlan", "supportNeeded"] as const;
const STATUS: Record<string, string> = { met: "Met", not_met: "Not met", unknown: "Unknown" };
const REGIONS: Record<string, string> = {
	"44180": "fixture-previous-confirmed-CBSA",
	"44100": "fixture-new-confirmed-CBSA",
};
const SPRINGFIELD_IL = { city: "Springfield", stateProvince: "IL", country: "US" };

async function faultOn(action: string, body: () => Promise<unknown>) {
	const name = `mw_fault_${randomUUID().replaceAll("-", "")}`;
	await W.c.admin.execute(
		sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS
		$$BEGIN RAISE EXCEPTION 'required_consequence_before_completion'; END$$`),
	);
	await W.c.admin.execute(
		sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_event FOR EACH ROW
		WHEN (NEW.action = '${action}') EXECUTE FUNCTION ${name}()`),
	);
	const text = (e: unknown): string =>
		e instanceof Error ? `${e.message} ${text(e.cause)}` : e ? String((e as { message?: string }).message ?? e) : "";
	try {
		const outcome = (await body()) as { status?: string; error?: { code?: string } };
		if (outcome?.status === "refused" && outcome.error?.code === "required_write_failed")
			return "required_write_failed";
		return outcome;
	} catch (error) {
		if ((error as { code?: string }).code === "required_write_failed") return "required_write_failed";
		if (/required_consequence_before_completion/.test(text(error))) return "required_write_failed";
		throw error;
	} finally {
		await W.c.admin.execute(sql.raw(`DROP TRIGGER ${name} ON audit_event; DROP FUNCTION ${name}()`));
	}
}
const allAudits = async () =>
	new Set((await W.c.rows<{ id: string }>(sql`SELECT id::text AS id FROM audit_event`)).map((r) => r.id));
const auditsAfter = async (before: Set<string>) =>
	(
		await W.c.rows<{ id: string; action: string; body: string }>(
			sql`SELECT id::text AS id,action,to_jsonb(e)::text AS body FROM audit_event e ORDER BY recorded_at,id`,
		)
	).filter((r) => !before.has(r.id));
const runsOf = (p: { id: string }) =>
	W.c.rows<{
		id: string;
		outcome: string;
		reason: string | null;
		source_revision: string;
		demand_key: string;
		reference_activation: string | null;
	}>(sql`SELECT id,outcome,reason,source_revision,demand_key,reference_activation::text
		FROM assessment_run WHERE plant_id=${p.id} ORDER BY captured_at,id`);

async function staleRuns(w: WakePlant, k: LoadedWakeCase, demand: string, captured: string) {
	const sent = await W.notices(w.P);
	const ia = k.staleInput.action.arguments;
	if ("captured_source" in ia) assert.notEqual(ia.captured_source, ia.live_source);
	else assert.notEqual(ia.captured_organization_state, ia.live_organization_state);
	for (const s of [k.staleInput, k.staleClaim]) {
		assert.equal(s.action.operation, "intelligence.publishAssessment");
		assert.deepEqual(s.expected.result, { status: "superseded", current_assessment: "R0", notice_count: 0 });
		assert.equal(s.expected.event, null);
	}
	let moved = false;
	await W.run(
		w.P,
		W.scripted({
			during: async () => {
				if (moved) return;
				moved = true;
				await W.move(w, "Joined While Drafting");
			},
		}),
		1,
	);
	const stale = (await runsOf(w.P)).at(-1)!;
	assert.ok(stale.demand_key.startsWith(demand), `the ${demand} run ran`);
	assert.equal(stale.source_revision, captured, "captured at the input state the write left");
	assert.notEqual(await W.inputState(w.P), stale.source_revision, "the live input moved");
	assert.deepEqual([stale.outcome, stale.reason], ["superseded", "changed_input"]);
	assert.equal(await W.current(w.P), w.r0.runId);
	assert.equal(await W.notices(w.P), sent);

	const ca = k.staleClaim.action.arguments;
	assert.equal(ca.captured_source, ca.live_source);
	assert.equal(Number(ca.live_generation), Number(ca.captured_generation) + 1);
	let skew = 0;
	const job = createAssessmentJob({
		clock: { now: () => new Date(Date.parse(W.clock.now()) + skew).toISOString() as never },
	});
	let claimed!: () => void;
	const claimedNow = new Promise<void>((resolve) => (claimed = resolve));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let second: Promise<number> | undefined;
	let followup = "";
	let generation = 0;
	const claimOf = async (key: string) =>
		Number(
			(
				await W.c.one<{ g: unknown }>(sql`SELECT claim_generation AS g FROM job WHERE kind='assessment'
					AND subject_record_id=${w.P.id} AND producer_key=${key}`)
			).g,
		);
	const firstWorker = W.scripted({
		during: async () => {
			if (second) return;
			followup = (
				await W.c.one<{ k: string }>(sql`SELECT producer_key AS k FROM job WHERE kind='assessment'
					AND subject_record_id=${w.P.id} AND state='claimed'`)
			).k;
			generation = await claimOf(followup);
			skew += ASSESSMENT_TIMING.leaseMs + 1000;
			second = runAssessmentBatch(
				job,
				W.db,
				W.scripted({
					during: async () => {
						claimed();
						await gate;
						await W.move(w, "Joined After Takeover");
					},
				}),
				1,
			);
			await claimedNow;
		},
	});
	await W.isolate(w.P);
	assert.equal(await runAssessmentBatch(job, W.db, firstWorker, 1), 1);
	const taken = (await runsOf(w.P)).at(-1)!;
	assert.equal(taken.demand_key, followup);
	assert.ok(followup.startsWith("followup/"));
	assert.equal(await claimOf(followup), generation + 1, "a second worker holds the live claim");
	assert.equal(taken.source_revision, await W.inputState(w.P), "captured and live input are the same");
	assert.equal(taken.outcome, "pending", "the stale claim's publication is refused");
	assert.equal(await W.current(w.P), w.r0.runId);
	assert.equal(await W.notices(w.P), sent);
	release();
	assert.equal(await second, 1);
	const settled = (await runsOf(w.P)).find((x) => x.id === taken.id)!;
	assert.deepEqual([settled.outcome, settled.reason], ["superseded", "changed_input"]);
	assert.equal(await W.current(w.P), w.r0.runId, "R0 stays current");
	assert.equal(await W.notices(w.P), sent, "no notice");
	await W.c.admin.execute(sql`UPDATE job SET state='cancelled',finished_at=clock_timestamp(),lease_owner=NULL,
		lease_until=NULL,next_attempt_at=NULL WHERE kind='assessment' AND state IN ('ready','retry_wait','claimed')`);
}

async function unchangedInput(
	w: WakePlant,
	k: LoadedWakeCase,
	o: {
		write: () => Promise<unknown>;
		facts: () => Promise<Json>;
		action: string;
		org?: (o: WakeOrg) => Promise<unknown>;
		orgSweep?: () => Promise<string[]>;
	},
) {
	const e = k.expected.result as Json;
	const orgOf = o.org ?? W.orgState;
	const orgs = async () => ({ a: await orgOf(w.orgA), b: await orgOf(w.orgB) });
	assert.equal(k.action.arguments.wake_delivery, "paused");
	assert.equal(e.wake_delivery, "paused");

	const s = k.failure;
	assert.equal(s.action.arguments.fault, "required_consequence_before_completion");
	const before = await W.snapshot(w);
	assert.equal(before.input, w.r0.sourceRevision);
	assert.equal(before.current, w.r0.runId);
	const ids0 = await allAudits();
	assert.equal(await faultOn(o.action, o.write), s.expected.result.error_code);
	const state = s.expected.state as Json;
	assert.deepEqual(listed(await o.facts(), state.facts), state.facts, "the facts are as before");
	assert.deepEqual(await W.snapshot(w), before, "no input, organization, assessment, job, audit or notice change");
	assert.deepEqual(await auditsAfter(ids0), [], "no audit row anywhere (event null)");
	assert.equal(s.expected.event, null);
	assert.deepEqual(await W.sweep(w.P), [], "the sweep finds no change");

	const ids = await allAudits();
	const org0 = await orgs();
	const result = await o.write();
	assert.deepEqual(listed(await o.facts(), e.facts), e.facts, "the listed facts changed");
	const after = await W.snapshot(w);
	const org1 = await orgs();
	assert.equal(e.current_assessment, "R0");
	assert.equal(after.current, w.r0.runId, "R0 stays current");
	assert.equal(e.assessment_input_state, "fixture-state-11");
	assert.equal(after.input, w.r0.sourceRevision, "P's assessment input state is R0's");
	if (typeof e.organization_A_state === "object") {
		assert.deepEqual(e.organization_A_state, { different_from: "fixture-state-21" });
		assert.notDeepEqual(org1.a, org0.a, "Org-A's input state moves");
	} else {
		assert.equal(e.organization_A_state, "fixture-state-21");
		assert.deepEqual(org1.a, org0.a, "Org-A's input state is unchanged");
		assert.deepEqual(after.orgA, before.orgA);
	}
	assert.equal(e.organization_B_state, "fixture-state-31");
	assert.deepEqual(org1.b, org0.b, "Org-B's input state is unchanged");
	assert.deepEqual(after.orgB, before.orgB);
	assert.equal(after.assessmentJobs, before.assessmentJobs, "the write queues no assessment: the wake stays paused");
	assert.equal(after.notices, before.notices);
	const event = k.expected.event!;
	assert.deepEqual([event.kind, event.subject, event.private_care], ["domain_change", "P", null]);
	const events = await auditsAfter(ids);
	assert.ok(events.length > 0, "the write records its domain change");
	for (const row of events) {
		assert.equal(row.body.includes(CANARY), false, `${row.action} carries no private care`);
		assert.equal(/strained|struggling/i.test(row.body), false, `${row.action} carries no check-in answer`);
	}

	const r = k.replay.expected.result as Json;
	assert.equal(k.replay.action.arguments.exact_replay, true);
	assert.equal(k.replay.action.arguments.request_key, k.action.arguments.request_key);
	assert.deepEqual(await o.write(), result, "the same recorded outcome");
	assert.deepEqual([r.additional_effects, r.assessment_input_changes, e.replay_new_effects], [0, 0, 0]);
	assert.deepEqual(await W.snapshot(w), after, "an exact replay adds no effect and no input change");
	assert.deepEqual(await orgs(), org1);
	assert.deepEqual(await auditsAfter(ids), events);

	if (e.sweep_discovers_change) {
		assert.ok(o.orgSweep, "the change is one an organization sweep finds");
		const queued = await o.orgSweep();
		assert.ok(queued.includes(w.orgA.id) && !queued.includes(w.orgB.id), "the sweep finds Org-A's change only");
		const pending = async (org: WakeOrg) =>
			W.count(sql`SELECT count(*) AS n FROM network_intelligence_run WHERE organization_id=${org.id}
				AND outcome='pending'`);
		assert.deepEqual([await pending(w.orgA), await pending(w.orgB)], [1, 0], "one Network Intelligence demand");
		assert.deepEqual(await orgs(), org1, "a queued demand changes no published result");
	} else assert.equal(e.sweep_discovers_change, false);
	const runs = (await runsOf(w.P)).length;
	const demands = await W.sweep(w.P);
	assert.ok(demands.length <= 1);
	for (const d of demands) {
		await W.run(w.P);
		const j = await W.c.one<{ state: string; error_code: string | null }>(sql`SELECT state,error_code FROM job
			WHERE kind='assessment' AND subject_record_id=${w.P.id} AND producer_key=${d.producer_key}`);
		assert.deepEqual([j.state, j.error_code], ["succeeded", "unchanged"], "the change demand runs nothing");
	}
	assert.equal((await runsOf(w.P)).length, runs, "no new assessment run");
	assert.equal(await W.current(w.P), w.r0.runId);
	assert.equal(await W.inputState(w.P), w.r0.sourceRevision);
	assert.deepEqual(listed(await o.facts(), e.facts), e.facts);

	ok(await W.assessments.requestRefresh(W.db, w.P.actor, { requestId: randomUUID() }));
	await staleRuns(w, k, "manual/", w.r0.sourceRevision);
}

type Doc = { id: string; revision: string };
type Draft = { id: string; revision: string; answers: typeof BLANK };
async function launched(w: { A: { actor: RequestActor } }, answers: Partial<Record<keyof typeof BLANK, unknown>>) {
	const L = launch();
	ok(
		await L.writer.schedule(W.db, w.A.actor, {
			requestKey: randomUUID(),
			expectedRevision: "1",
			input: { date: "2026-10-10", reason: null },
		}),
	);
	const plan = ok(await L.reader.readPlan(W.db, w.A.actor)).plan;
	ok(
		await L.writer.recordOutcome(W.db, w.A.actor, {
			requestKey: randomUUID(),
			expectedRevision: plan.revision,
			input: { actualDate: "2026-10-11", attendance: 40, decisions: 6, note: null },
		}),
	);
	ok(
		await L.writer.saveDebriefDraft(W.db, w.A.actor, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { draftId: null, answers: { ...BLANK, ...answers } },
		}),
	);
	const draft = ok(await L.reader.readPlan(W.db, w.A.actor)).plan.debrief!.draft!;
	return { id: draft.id, revision: draft.revision, answers: draft.answers } as Draft;
}
const planOf = async (w: { A: { actor: RequestActor } }) => ok(await launch().reader.readPlan(W.db, w.A.actor)).plan;

const UNCHANGED: Row<unknown>[] = [
	row({
		id: "MW-CASE-017",
		marker: "AC:MW-CASE-017 ",
		operation: "documents.designateCoreValues",
		producer:
			"documentsWriter.designateCoreValues (documentId, expectedRevision) on P's native document saved three times; owner and reason come from the trusted context",
		arrange: async (w, k) => {
			const before = k.given["input-before"] as { parsedDocRevision: number; parsedNonemptyContent: string };
			let doc: Doc | null = null;
			for (let n = 1; n <= before.parsedDocRevision; n++) {
				const text = n === before.parsedDocRevision ? before.parsedNonemptyContent : `Draft values ${n}`;
				doc = ok(
					await documentsWriter.saveNative(W.db, w.A.actor, {
						title: "Core values",
						body: nativeFromText(text),
						expectedRevision: doc?.revision ?? "0",
						...(doc ? { documentId: doc.id } : {}),
					}),
				) as Doc;
			}
			return { doc: doc! };
		},
		facts: async (w) => {
			const { doc } = w.arranged as { doc: Doc };
			const evidence = ok(await documentsWriter.readCoreValuesEvidence(W.db, w.A.actor, {}));
			const current = await W.c.one<{ revision: string; body: unknown }>(sql`SELECT d.revision::text AS revision,
				r.body FROM document d JOIN document_revision r ON r.id=d.current_revision_id WHERE d.id=${doc.id}`);
			return {
				designatedValuesDocument: evidence.documentId === doc.id ? "Doc-Values" : evidence.documentId,
				documentedValuesEvidence: evidence.documentId && evidence.text ? "recorded_native_document" : null,
				parsedDocRevision: Number(current.revision),
				parsedNonemptyContent: nativeText(readNative(current.body as never).body),
			};
		},
		write: async (w, k) => {
			const { doc } = w.arranged as { doc: Doc };
			const args = k.action.arguments as { documentId: string; expectedRevision: number };
			assert.equal(args.documentId, "Doc-Values");
			return documentsWriter.designateCoreValues(W.db, w.A.actor, {
				documentId: doc.id,
				expectedRevision: String(args.expectedRevision),
			});
		},
		action: "documents.designated",
	}),
	row({
		id: "MW-CASE-018",
		marker: "AC:MW-CASE-018 ",
		operation: "wiki.reading.updateProgress",
		producer:
			"createWikiProducer().updateProgress (articleId = canonicalArticleId, fraction = progressRatio) by Admin A, P's linked lead, on the six Discovery articles of the active release",
		arrange: async (w, k) => {
			const before = k.given["input-before"] as { otherFiveRatios: number[]; coachRatio: number };
			const { release_id: release } = await W.c.one<{ release_id: string }>(
				sql`SELECT release_id FROM reference_activation ORDER BY activation_number DESC LIMIT 1`,
			);
			const { id: section } = await W.c.one<{ id: string }>(
				sql`SELECT id FROM reference_item WHERE kind='section' AND canonical_key='framework/methodology'`,
			);
			for (const [index, a] of foundations.articles.entries()) {
				await W.c.admin.execute(sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id)
					VALUES(${a.id},'article',${a.slug},'00000000-0000-0000-0000-000000000000') ON CONFLICT DO NOTHING`);
				await W.c.admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,
					title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,
					section_id) SELECT ${randomUUID()},${a.id},'00000000-0000-0000-0000-000000000000',${release},1,${a.title},
					${a.slug},${a.title},${"Discovery body " + (index + 1)},'safe_mdx',0,${index + 1},${randomUUID()},
					clock_timestamp(),true,1,${section}
					WHERE NOT EXISTS(SELECT FROM article_revision WHERE article_id=${a.id})`);
			}
			const lead = randomUUID();
			await W.c.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,
				adult_classification,commitment_state,pipeline_position,state,created_at,linked_account_id)
				VALUES(${lead},${w.P.id},${w.P.id},'Alex Lead','other','leader','adult','unknown','1','live',
				clock_timestamp(),${w.A.id})`);
			const others = foundations.articles.filter((a) => a.id !== COACH);
			for (const [i, a] of others.entries())
				ok(
					await wiki.updateProgress(W.db, w.A.actor, {
						requestKey: randomUUID(),
						input: { articleId: a.id, fraction: String(before.otherFiveRatios[i]) },
					}),
				);
			ok(
				await wiki.updateProgress(W.db, w.A.actor, {
					requestKey: randomUUID(),
					input: { articleId: COACH, fraction: String(before.coachRatio) },
				}),
			);
			return { lead };
		},
		facts: async (w) => {
			const { lead } = w.arranged as { lead: string };
			const stats = await wiki.readingStats(W.db, w.A.actor, {});
			const st = ok(stats);
			const linked = await W.c.one<{ ok: boolean }>(sql`SELECT EXISTS(SELECT FROM person WHERE id=${lead}
				AND plant_id=${w.P.id} AND linked_account_id=${w.A.id} AND state='live') AS ok`);
			const seat = await W.c.one<{ ok: boolean }>(sql`SELECT EXISTS(SELECT FROM seat WHERE account_id=${w.A.id}
				AND plant_id=${w.P.id} AND role='admin' AND ended_at IS NULL) AS ok`);
			return {
				eligibleAccount: stats.status === "ok" ? "Account-A" : null,
				linkedLeadPerson: linked.ok ? "Person-A" : null,
				samePlantAdminSeatActive: seat.ok,
				otherFiveRatios: st.articles.filter((a) => a.articleId !== COACH).map((a) => Number(a.ratio)),
				coachRatio: Number(st.articles.find((a) => a.articleId === COACH)!.ratio),
				DiscoveryCompletion: st.discoveryComplete,
			};
		},
		write: async (w, k) => {
			const args = k.action.arguments as {
				canonicalArticleId: string;
				sourceId: { article: string };
				progressRatio: number;
				request_key: string;
			};
			assert.equal(args.sourceId.article, args.canonicalArticleId);
			return wiki.updateProgress(W.db, w.A.actor, {
				requestKey: W.key(args.request_key),
				input: { articleId: args.canonicalArticleId, fraction: String(args.progressRatio) },
			});
		},
		action: "wiki.reading_recorded",
	}),
	row({
		id: "MW-CASE-020",
		marker: "AC:MW-CASE-020 ",
		operation: "launch.addGuestAttendance",
		producer:
			"createLaunchWriter().addGuestAttendance ({displayName}) for each new named guest, after the Launch outcome (actual occurrence) and a draft debrief answering missing names yes",
		arrange: async (w) => ({ draft: await launched(w, { missingNames: "yes", missingCount: 1 }) }),
		facts: async (w) => {
			const plan = await planOf(w);
			const jordan = await W.count(sql`SELECT count(*) AS n FROM person WHERE plant_id=${w.P.id}
				AND display_name='Jordan Lee' AND state='live'`);
			const answers = (plan.debrief?.draft ?? plan.debrief?.submitted)?.answers;
			return {
				actualOccurrenceExists: plan.outcome !== null,
				namedGuestCount: plan.guests.named?.length ?? plan.guests.count,
				peopleNamedJordan: jordan,
				missingGuestNamesAnswer: answers?.missingNames ?? null,
			};
		},
		write: async (w, k) => {
			const args = k.action.arguments as {
				namedGuests: { kind: string; displayName: string; email: null; phone: null }[];
				request_key: string;
			};
			assert.deepEqual(
				args.namedGuests.map((g) => [g.kind, g.email, g.phone]),
				[["new", null, null]],
			);
			return launch().writer.addGuestAttendance(W.db, w.A.actor, {
				requestKey: W.key(args.request_key),
				input: { displayName: args.namedGuests[0]!.displayName },
			});
		},
		action: "launch.changed",
	}),
	row({
		id: "MW-CASE-021",
		marker: "AC:MW-CASE-021 ",
		operation: "launch.submitDebrief",
		producer:
			"createLaunchWriter().submitDebrief (draftId, expectedRevision = the reviewed draft revision, the draft's answers) after the Launch outcome",
		arrange: async (w) => ({
			draft: await launched(w, {
				wentWell: "Yes, the welcome team was ready.",
				toChange: "No, nothing to change yet.",
				operations: "Yes, setup ran on time.",
				followUpPlan: "Yes, calls go out Monday.",
				supportNeeded: "No, no support needed.",
				missingNames: "yes",
				missingCount: 2,
			}),
		}),
		facts: async (w) => {
			const plan = await planOf(w);
			const answers = (plan.debrief?.draft ?? plan.debrief?.submitted)!.answers;
			return {
				draftSixAreaAnswered: [...WRITTEN.map((key) => answers[key]), answers.missingNames].filter((x) => x !== null)
					.length,
				draftPositiveAnswers: WRITTEN.filter((key) => /^yes\b/i.test(answers[key] ?? "")).length,
				submitted: plan.debrief?.submitted != null,
				guestCue: answers.missingNames === "yes" ? "missing_names" : answers.missingNames,
				debriefCriterion: STATUS[plan.evidence.debriefDone.status],
				guestCriterion: STATUS[plan.evidence.guestNamesEntered.status],
				publishedSummary: plan.summary?.published[0]?.body ?? null,
			};
		},
		write: async (w, k) => {
			const { draft } = w.arranged as { draft: Draft };
			const args = k.action.arguments as { formVersion: string; request_key: string };
			assert.equal(args.formVersion, "six-areas-v1");
			return launch().writer.submitDebrief(W.db, w.A.actor, {
				requestKey: W.key(args.request_key),
				expectedRevision: draft.revision,
				input: { draftId: draft.id, answers: draft.answers },
			});
		},
		action: "launch.debrief_submitted",
	}),
	row({
		id: "MW-CASE-026",
		marker: "AC:MW-CASE-026 ",
		operation: "organizations.correctReportingLocation",
		producer:
			"organization adapter organizations.correctReportingLocation (locality, referenceVersionId, regionItemId of the selected official region, expectedRevision = the reviewed plant revision)",
		arrange: async (w) => {
			const now = (await readReportingLocation(W.db, w.A.actor))!;
			const missouri = (await suggestRegions(W.db, w.A.actor, { ...SPRINGFIELD_IL, stateProvince: "MO" }))!.find(
				(c) => c.area.code === "44180",
			)!;
			await W.c.admin.execute(sql`INSERT INTO plant_geography(plant_id,city,state_province,country,region_item_id,
				reference_version_id,committed_at,effective_at) VALUES(${w.P.id},${SPRINGFIELD_IL.city},
				${SPRINGFIELD_IL.stateProvince},${SPRINGFIELD_IL.country},${missouri.regionItemId},${now.referenceVersionId},
				clock_timestamp()-interval '30 days',clock_timestamp()-interval '30 days')`);
			return { cmd: null as unknown };
		},
		facts: async (w) => {
			const at = (await readReportingLocation(W.db, w.A.actor))!;
			const code = (at.region as { code?: string } | null)?.code ?? null;
			return {
				primaryReportingRegion: code ? (REGIONS[code] ?? code) : null,
				actualCity: at.locality.city,
				actualState: at.locality.stateProvince,
				chosenAreaAttested: code === null && !!at.locality.city,
			};
		},
		write: async (w, k) => {
			const a = w.arranged as { cmd: unknown };
			const args = k.action.arguments as {
				selection: { kind: string; regionRef: { name: string } };
				request_key: string;
			};
			assert.equal(args.selection.kind, "select_official_region");
			if (!a.cmd) {
				const now = (await readReportingLocation(W.db, w.A.actor))!;
				const region = (await suggestRegions(W.db, w.A.actor, SPRINGFIELD_IL))!.find(
					(c) => c.area.title === args.selection.regionRef.name,
				)!;
				assert.equal(region.area.code, "44100");
				a.cmd = {
					requestKey: W.key(args.request_key),
					expectedRevision: now.revision,
					input: {
						plant: w.A.ctx.selected,
						locality: SPRINGFIELD_IL,
						referenceVersionId: now.referenceVersionId,
						regionItemId: region.regionItemId,
					},
				};
			}
			return gatedTransaction(W.db, async (tx) => {
				assert.ok(await RequestActor.claimWrite(tx, w.A.session as never, w.A.ctx.selected as never));
				return organizations["organizations.correctReportingLocation"](
					tx,
					w.A.session as never,
					w.A.ctx.selected as never,
					a.cmd as never,
				);
			});
		},
		action: "plant.profile_changed",
		org: async (o) => ({
			view: await readIntelligence(W.db, o.reader, { level: "region", runId: null }),
			materialRevision: (
				await W.c.one<{ r: string }>(sql`SELECT material_revision::text AS r FROM organization WHERE id=${o.id}`)
			).r,
		}),
	}),
];

const R2 = fixture("R2");
const RELEASES: Record<string, string> = { "methodology-2026.11": "Release-R1", R2: "Release-R2" };

test("AC:MW-CASE-025 reference.activateGeneration fails all or nothing with the wakeup paused: P's input stays, the sweep finds the new activation, a replay adds nothing and stale publications are superseded", async () => {
	const k = wakeCase("MW-CASE-025");
	const args = k.action.arguments as { expectedActivationNumber: number; reason: string; request_key: string };
	assert.equal(k.action.operation, "reference.activateGeneration");
	for (const s of [k.failure, k.replay]) assert.equal(s.action.operation, k.action.operation);
	const w = await W.plant(k.id, async () => ({}));
	const run0 = await W.c.one<{ reference_activation: string }>(
		sql`SELECT reference_activation::text FROM assessment_run WHERE id=${w.r0.runId}`,
	);
	assert.equal(
		Number(run0.reference_activation),
		(k.given.R0 as { reference_activation: number }).reference_activation,
	);

	const p = await promotions(W.c.database, (key) => {
		assert.equal(key, "R2");
		return R2;
	});
	await p.seed();
	const cmd = p.command("R2", String(args.expectedActivationNumber), "activate", {
		requestKey: W.key(args.request_key),
		reason: args.reason,
	});
	const promote = () => p.service.promote(cmd, "R2");
	let done = false;
	const facts = async () => {
		const cur = (await p.service.current())!;
		const all = {
			activeActivationNumber: Number(cur.activation_number),
			activeRelease: RELEASES[cur.release_key] ?? cur.release_key,
			plantassessment_input_state: (await W.inputState(w.P)) === w.r0.sourceRevision ? "fixture-state-11" : "changed",
			candidateComplete: validateBundle(R2.bundle, R2.policy).ok,
		};
		return pick(all, done ? (k.expected.result as Json).facts! : (k.failure.expected.state as Json).facts!);
	};
	assert.deepEqual(await facts(), strip(k.given["input-before"] as Json));
	const referenceDemands = () =>
		W.c.rows<{ producer_key: string }>(sql`SELECT producer_key FROM job WHERE kind='assessment'
			AND subject_record_id=${w.P.id} AND producer_key LIKE 'reference/%' ORDER BY eligible_at,id`);
	const activations = () => W.count(sql`SELECT count(*) AS n FROM audit_event WHERE action='reference.activated'`);

	const fault = `mw_fault_${randomUUID().replaceAll("-", "")}`;
	const before = await W.snapshot(w);
	const seen = await activations();
	await W.c.admin.execute(
		sql.raw(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS
		$$BEGIN RAISE EXCEPTION 'required_consequence_before_completion'; END$$`),
	);
	await W.c.admin.execute(
		sql.raw(`CREATE TRIGGER ${fault} BEFORE INSERT ON audit_event FOR EACH ROW
		WHEN (NEW.action = 'reference.activated') EXECUTE FUNCTION ${fault}()`),
	);
	try {
		await assert.rejects(promote(), (e: Error) =>
			/required_consequence_before_completion/.test(`${e.message} ${(e.cause as Error | undefined)?.message}`),
		);
	} finally {
		await W.c.admin.execute(sql.raw(`DROP TRIGGER ${fault} ON audit_event; DROP FUNCTION ${fault}()`));
	}
	assert.equal(k.failure.expected.result.error_code, "required_write_failed", "a rolled-back transaction (D-2598)");
	assert.deepEqual(await facts(), (k.failure.expected.state as Json).facts);
	assert.deepEqual(await W.snapshot(w), before, "no input, organization, assessment, job, audit or notice change");
	assert.equal(await activations(), seen);
	assert.equal(
		await W.count(sql`SELECT count(*) AS n FROM reference_release WHERE release_key='R2'`),
		0,
		"the candidate's install rolled back too",
	);
	assert.equal(k.failure.expected.event, null);
	assert.deepEqual(await W.sweep(w.P), []);
	assert.deepEqual(await referenceDemands(), [], "the sweep finds no change");

	const e = k.expected.result as Json;
	assert.equal(args.request_key, k.replay.action.arguments.request_key);
	const receipt = await promote();
	done = true;
	assert.deepEqual(await facts(), e.facts);
	assert.equal(Number(receipt.number), e.reference_activation);
	const after = await W.snapshot(w);
	assert.deepEqual(
		after,
		before,
		"R0 current, P's input, Org-A and Org-B unchanged, no job queued: the wake stays paused",
	);
	assert.equal(e.assessment_input_state, "fixture-state-11");
	assert.deepEqual([e.organization_A_state, e.organization_B_state], ["fixture-state-21", "fixture-state-31"]);
	assert.equal(e.wake_delivery, "paused");
	const [event] = await W.c.rows<{ body: string }>(sql`SELECT to_jsonb(a)::text AS body FROM audit_event a
		WHERE action='reference.activated' AND request_key=${cmd.requestKey}`);
	assert.ok(event, "the activation is recorded");
	assert.deepEqual([k.expected.event!.kind, k.expected.event!.private_care], ["domain_change", null]);
	assert.equal(event.body.includes(CANARY), false, "the activation carries no private care");
	assert.equal(/strained|struggling/i.test(event.body), false);

	assert.equal(receipt.replayed, false);
	const again = await promote();
	assert.deepEqual({ ...again, replayed: false }, receipt, "the same recorded outcome");
	assert.equal(again.replayed, true);
	assert.equal(await activations(), seen + 1, "no additional effect");
	assert.deepEqual(await W.snapshot(w), after, "no assessment input change");
	assert.deepEqual(
		[k.replay.expected.result.additional_effects, k.replay.expected.result.assessment_input_changes],
		[0, 0],
	);

	assert.equal(e.sweep_discovers_change, true);
	assert.deepEqual(await W.sweep(w.P), [], "no change demand: P's input did not move");
	assert.deepEqual(
		(await referenceDemands()).map((d) => d.producer_key),
		[`reference/${receipt.number}`],
	);
	assert.equal(await W.current(w.P), w.r0.runId);

	const runs = () =>
		W.c.rows<{
			id: string;
			outcome: string;
			reason: string | null;
			source_revision: string;
			demand_key: string;
			reference_activation: string | null;
		}>(sql`SELECT id,outcome,reason,source_revision,demand_key,
			reference_activation::text FROM assessment_run WHERE plant_id=${w.P.id} ORDER BY captured_at,id`);
	const sent = await W.notices(w.P);
	const ia = k.staleInput.action.arguments;
	assert.notEqual(ia.captured_source, ia.live_source);
	let moved = false;
	await W.run(
		w.P,
		W.scripted({
			during: async () => {
				if (moved) return;
				moved = true;
				await W.move(w, "Joined While Drafting");
			},
		}),
		1,
	);
	const stale = (await runs()).at(-1)!;
	assert.equal(stale.demand_key, `reference/${receipt.number}`);
	assert.equal(stale.reference_activation, receipt.number);
	assert.equal(stale.source_revision, w.r0.sourceRevision, "captured at R0's input state");
	assert.notEqual(await W.inputState(w.P), stale.source_revision, "the live input moved");
	for (const s of [k.staleInput, k.staleClaim])
		assert.deepEqual(s.expected.result, { status: "superseded", current_assessment: "R0", notice_count: 0 });
	assert.deepEqual([stale.outcome, stale.reason], ["superseded", "changed_input"]);
	assert.equal(await W.current(w.P), w.r0.runId);
	assert.equal(await W.notices(w.P), sent);

	const ca = k.staleClaim.action.arguments;
	assert.equal(Number(ca.live_generation), Number(ca.captured_generation) + 1);
	let skew = 0;
	const job = createAssessmentJob({
		clock: { now: () => new Date(Date.parse(W.clock.now()) + skew).toISOString() as never },
	});
	let claimed!: () => void;
	const claimedNow = new Promise<void>((resolve) => (claimed = resolve));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let second: Promise<number> | undefined;
	let followup = "";
	let generation = 0;
	const claimOf = async (key: string) =>
		Number(
			(
				await W.c.one<{ g: unknown }>(sql`SELECT claim_generation AS g FROM job WHERE kind='assessment'
					AND subject_record_id=${w.P.id} AND producer_key=${key}`)
			).g,
		);
	const firstWorker = W.scripted({
		during: async () => {
			if (second) return;
			followup = (
				await W.c.one<{ k: string }>(sql`SELECT producer_key AS k FROM job WHERE kind='assessment'
					AND subject_record_id=${w.P.id} AND state='claimed'`)
			).k;
			generation = await claimOf(followup);
			skew += ASSESSMENT_TIMING.leaseMs + 1000;
			second = runAssessmentBatch(
				job,
				W.db,
				W.scripted({
					during: async () => {
						claimed();
						await gate;
						await W.move(w, "Joined After Takeover");
					},
				}),
				1,
			);
			await claimedNow;
		},
	});
	await W.isolate(w.P);
	assert.equal(await runAssessmentBatch(job, W.db, firstWorker, 1), 1);
	const taken = (await runs()).at(-1)!;
	assert.equal(taken.demand_key, followup);
	assert.ok(followup.startsWith("followup/"));
	assert.equal(await claimOf(followup), generation + 1, "a second worker holds the live claim");
	assert.equal(taken.source_revision, await W.inputState(w.P), "captured and live input are the same");
	assert.equal(taken.outcome, "pending", "the stale claim's publication is refused");
	assert.equal(await W.current(w.P), w.r0.runId);
	assert.equal(await W.notices(w.P), sent);
	release();
	assert.equal(await second, 1);
	const settled = (await runs()).find((x) => x.id === taken.id)!;
	assert.deepEqual([settled.outcome, settled.reason], ["superseded", "changed_input"]);
	assert.equal(await W.current(w.P), w.r0.runId, "R0 stays current");
	assert.equal(await W.notices(w.P), sent, "no notice");
	await W.c.admin.execute(sql`UPDATE job SET state='cancelled',finished_at=clock_timestamp(),lease_owner=NULL,
		lease_until=NULL,next_attempt_at=NULL WHERE kind='assessment' AND state IN ('ready','retry_wait','claimed')`);
});

for (const r of UNCHANGED)
	test(`${r.marker}${r.operation} fails all or nothing with the wakeup paused: P's assessment input stays R0's, the sweep runs nothing, a replay adds nothing and stale publications are superseded`, async () => {
		assert.equal(r.marker, `AC:${r.id} `);
		const k = wakeCase(r.id);
		assert.equal(k.action.operation, r.operation);
		assert.equal(k.replay.action.operation, r.operation);
		assert.equal(k.failure.action.operation, r.operation);
		const w = await W.plant(r.id, (base) => r.arrange(base, k));
		const facts = () => r.facts(w);
		const inputBefore = strip(k.given["input-before"] as Json);
		assert.deepEqual(listed(await facts(), inputBefore), inputBefore, "the arranged input-before");
		await unchangedInput(w, k, { write: () => r.write(w, k), facts, action: r.action!, org: r.org });
	});

const sharing = sharingOperations({
	invitation: async () => {},
	invalidate: () => sql`UPDATE job SET state=state WHERE false`,
});
const orgLabel = (state: string) => (same: boolean) => (same ? state : { different_from: state });
async function orgStates(w: WakePlant) {
	const baseline = { a: await W.orgState(w.orgA), b: await W.orgState(w.orgB) };
	return async () => ({
		"Org-A-assessment_input_state": orgLabel("fixture-state-21")(
			JSON.stringify(await W.orgState(w.orgA)) === JSON.stringify(baseline.a),
		),
		"Org-B-assessment_input_state": orgLabel("fixture-state-31")(
			JSON.stringify(await W.orgState(w.orgB)) === JSON.stringify(baseline.b),
		),
	});
}

test("AC:MW-CASE-022 privacy.setSharing fails all or nothing with the wakeup paused: Org-A's input moves, Org-B's stays, the organization sweep finds the change, a replay adds nothing and stale publications are superseded", async () => {
	const k = wakeCase("MW-CASE-022");
	assert.equal(k.action.operation, "privacy.setSharing");
	for (const s of [k.failure, k.replay]) assert.equal(s.action.operation, k.action.operation);
	const args = k.action.arguments as { category: string; enabled: boolean; request_key: string };
	const w = await W.plant(k.id, async () => ({}));
	const shared = async (p: { id: string }, o: WakeOrg) =>
		(
			await W.c.one<{ on: boolean }>(sql`SELECT shared_findings AS on FROM affiliation
				WHERE plant_id=${p.id} AND organization_id=${o.id}`)
		).on;
	const states = await orgStates(w);
	const facts = async () => ({
		"Org-A-healthShared": await shared(w.P, w.orgA),
		"Org-B-healthShared": await shared(w.Q, w.orgB),
		...(await states()),
	});
	assert.deepEqual(await facts(), strip(k.given["input-before"] as Json));
	const link = await W.c.one<{ revision: string; consent: string }>(sql`SELECT revision::text AS revision,
		consent_revision::text AS consent FROM affiliation WHERE id=${w.P.affiliation}`);
	const command = {
		requestKey: W.key(args.request_key),
		expectedRevision: link.revision,
		input: {
			plant: { kind: "plant", id: w.P.id },
			organization: { kind: "organization", id: w.orgA.id, organizationKind: "sending_network" },
			relationshipId: w.P.affiliation,
			expectedConsentRevision: link.consent,
			category: args.category,
			enabled: args.enabled,
		},
	};
	const write = () =>
		gatedTransaction(W.db, (tx) =>
			sharing["privacy.setSharing"](tx, w.A.session as never, w.A.ctx.selected as never, command as never),
		);
	await unchangedInput(w, k, {
		write,
		facts,
		action: "sharing.changed",
		orgSweep: () => scheduleIntelligenceRefresh(W.db),
	});

	const s = k.staleInput;
	const ia = s.action.arguments as { captured_organization_state: string; live_organization_state: string };
	assert.notEqual(ia.captured_organization_state, ia.live_organization_state);
	assert.deepEqual(s.expected.result, { status: "superseded", current_assessment: "R0", notice_count: 0 });
	const { id: due } = await W.c.one<{ id: string }>(sql`SELECT id FROM network_intelligence_run
		WHERE organization_id=${w.orgA.id} AND outcome='pending'`);
	const claim = (await claimIntelligenceRefresh(W.db, {}, due))!;
	const shown = await W.orgState(w.orgA);
	const sent = await W.notices(w.P);
	const again = await W.c.one<{ revision: string; consent: string }>(sql`SELECT revision::text AS revision,
		consent_revision::text AS consent FROM affiliation WHERE id=${w.P.affiliation}`);
	await gatedTransaction(W.db, (tx) =>
		sharing["privacy.setSharing"](
			tx,
			w.A.session as never,
			w.A.ctx.selected as never,
			{
				...command,
				requestKey: randomUUID(),
				expectedRevision: again.revision,
				input: { ...command.input, expectedConsentRevision: again.consent, enabled: true },
			} as never,
		),
	);
	assert.equal(
		await runIntelligenceRefresh(W.db, claim),
		s.expected.result.status,
		"Org-A's captured contributors moved",
	);
	assert.equal(
		(await W.c.one<{ outcome: string }>(sql`SELECT outcome FROM network_intelligence_run WHERE id=${due}`)).outcome,
		"superseded",
	);
	const kept = (await W.orgState(w.orgA))!;
	assert.ok(shown?.run, "Org-A has a published result");
	assert.deepEqual([kept.run, kept.history], [shown.run, shown.history], "Org-A keeps its published result");
	assert.equal(await W.current(w.P), w.r0.runId, "R0 stays current");
	assert.equal(await W.notices(w.P), sent, "no notice");
});

test("AC:MW-CASE-024 intelligence.releaseAssessmentToOversight fails all or nothing with the wakeup paused: oversight reads the persisted release, P's and the organizations' inputs stay, the organization sweep finds the change, a replay adds nothing and stale publications are superseded", async () => {
	const k = wakeCase("MW-CASE-024");
	assert.equal(k.action.operation, "intelligence.releaseAssessmentToOversight");
	for (const s of [k.failure, k.replay]) assert.equal(s.action.operation, k.action.operation);
	const args = k.action.arguments as {
		releaseCause: "elapsed_72_hours";
		currentSharingWitness: { shared_findings: boolean };
		request_key: string;
	};
	const before = k.given["input-before"] as { assessmentAvailableAt: string };
	let earlier = "";
	const w = await W.plant(
		k.id,
		async (base) => {
			earlier = (await W.publish(base.P)).runId;
			return {};
		},
		{ seen: false },
	);
	const available = before.assessmentAvailableAt;
	await W.c.admin.execute(sql`UPDATE assessment_run SET available_at=${available}::timestamptz-interval '9 days'
		WHERE id=${earlier}`);
	await W.c.admin.execute(sql`UPDATE assessment_run SET available_at=${available}::timestamptz WHERE id=${w.r0.runId}`);
	const label: Record<string, string> = { [earlier]: "Assessment-R0", [w.r0.runId]: "Assessment-R1" };
	const iso = (at: Date | string) => new Date(at).toISOString().replace(".000Z", "Z");
	const states = await orgStates(w);
	const facts = async () => {
		const run = await W.c.one<{ available_at: string; opened: boolean }>(sql`SELECT available_at,
			EXISTS(SELECT FROM assessment_seen s WHERE s.run_id=r.id) AS opened FROM assessment_run r WHERE r.id=${w.r0.runId}`);
		const shown = (await getPlant(W.db, w.orgA.reader, w.P.id, () => {}))!.assessment;
		assert.ok(shown.status === "released");
		const { "Org-A-assessment_input_state": orgA } = await states();
		return {
			assessmentAvailableAt: iso(run.available_at),
			asOf: iso(new Date(Date.parse(run.available_at) + 72 * 3_600_000)),
			eligibleHumanOpened: run.opened,
			releasedAssessment: label[shown.runId] ?? shown.runId,
			plantassessment_input_state: (await W.inputState(w.P)) === w.r0.sourceRevision ? "fixture-state-11" : "changed",
			"Org-A-assessment_input_state": orgA,
		};
	};
	assert.deepEqual(await facts(), strip(k.given["input-before"] as Json));
	assert.equal(
		(
			await W.c.one<{ on: boolean }>(sql`SELECT shared_findings AS on FROM affiliation
				WHERE plant_id=${w.P.id} AND organization_id=${w.orgA.id}`)
		).on,
		args.currentSharingWitness.shared_findings,
		"the current sharing witness",
	);
	const release = createRelease({ clock: W.clock });
	const input = {
		plantId: w.P.id,
		assessmentId: w.r0.runId,
		releaseCause: args.releaseCause,
		requestKey: W.key(args.request_key),
	};
	const write = async () => {
		const reply = await release.releaseAssessmentToOversight(W.db, input);
		assert.equal(reply.status, "ok");
		return reply;
	};
	await unchangedInput(w, k, {
		write,
		facts,
		action: "intelligence.released",
		orgSweep: () => scheduleIntelligenceRefresh(W.db),
	});
	const persisted = await W.c.one<{ cause: string; request_key: string }>(sql`SELECT cause,request_key::text
		FROM assessment_release WHERE run_id=${w.r0.runId}`);
	assert.deepEqual(persisted, { cause: args.releaseCause, request_key: input.requestKey }, "one persisted release");
	const shown = await listPlants(W.db, w.orgA.reader);
	const row = shown!.plants.find((p) => p.plantId === w.P.id)!;
	assert.equal(row.health === "not_assessed", false, "listPlants reads the same release");
	const due = await W.c.one<{ id: string }>(sql`SELECT id FROM network_intelligence_run
		WHERE organization_id=${w.orgA.id} AND outcome='pending'`);
	const claim = (await claimIntelligenceRefresh(W.db, {}, due.id))!;
	assert.equal(await runIntelligenceRefresh(W.db, claim), "published");
	const next = (await readIntelligence(W.db, w.orgA.reader, { level: "portfolio", runId: null }))!;
	const p = next.groups.flatMap((g) => g.rows).find((r) => r.plantId === w.P.id)!;
	assert.ok(p.status === "shared" && p.assessment.status === "released");
	assert.equal(p.assessment.runId, w.r0.runId, "Network Intelligence's next run reads the persisted release");
});
