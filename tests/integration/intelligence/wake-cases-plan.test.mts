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
	createSignals,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import { createLaunchReader, createLaunchWriter } from "../../../packages/domain/src/launch/index.ts";
import { createPhaseWriter } from "../../../packages/domain/src/phases/writes.ts";
import { phaseReader } from "../../../packages/domain/src/phases/reads.ts";
import { eligibleOwner } from "../../../packages/domain/src/tasks/owner.ts";
import { validateBundle } from "../../../packages/reference/src/index.ts";
import { ok } from "../../support/fixture.mts";
import { fixture } from "../../reference/releases/fixtures.mts";
import { promotions } from "../../reference/releases/promotions.mts";
import { CANARY } from "./assessment-church.mts";
import { wakeCase, wakeWorld, type LoadedWakeCase, type WakePlant, type WakeWorld } from "./wake-world.mts";

let W: WakeWorld;
let dbClock: { now: () => never };
before(async () => {
	W = await wakeWorld("mw2");
	const shift = Date.parse((await W.c.one<{ t: string }>(sql`SELECT clock_timestamp()::text AS t`)).t) - Date.now();
	dbClock = { now: () => new Date(Date.now() + shift).toISOString() as never };
});
after(() => W?.close());

type Json = Record<string, unknown>;
type Row<T> = {
	id: string;
	marker: `AC:${string} `;
	operation: string;
	producer: string;
	arrange: (w: Omit<WakePlant<T>, "r0" | "arranged">, k: LoadedWakeCase) => Promise<T>;
	facts: (w: WakePlant<T>) => Promise<Json>;
	write: (w: WakePlant<T>, k: LoadedWakeCase) => Promise<unknown>;
	action?: string;
};
const row = <T,>(r: Row<T>) => r as Row<unknown>;

const strip = ({ fixture_type: _, ...rest }: Json) => rest;
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
				recorded_at,operation_id) VALUES(${id},${w.P.id},'creation',NULL,1,'Plant created in EveryField.',
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
