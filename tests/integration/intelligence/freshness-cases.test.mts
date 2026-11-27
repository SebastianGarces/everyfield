import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import * as c from "../../../packages/contracts/src/intelligence/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createFollowUpWriter, withFollowUpWrite } from "../../../packages/domain/src/followups/index.ts";
import {
	ASSESSMENT_TIMING,
	captureFacts,
	createAssessmentJob,
	createAssessments,
	createPrivateCare,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import { createAttendanceWriter, withMeetingsWrite } from "../../../packages/domain/src/meetings/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { readIntelligence, requestIntelligenceRefresh } from "../../../packages/domain/src/oversight/intelligence.ts";
import { commitments, peopleWriter, withPeopleWrite } from "../../../packages/domain/src/people/index.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { ok, waitingOnLock } from "../../support/fixture.mts";
import { caseOf, type Case } from "../target/sql/core/support.mts";
import { church, type Church, type ChurchPlant, type StoredRun } from "./assessment-church.mts";

type Dated = Case & { clock: { now: string }; expected: Case["expected"] & { event: unknown } };
const K = (id: string) => caseOf("intelligence", id) as Dated;
const given = <T,>(k: Case, name: string) => (k.given[name] as { value: T }).value;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const R1_AS_OF = Date.parse(given<string>(K("ASMT-001"), "R1_as_of"));
const NOW = Date.parse(K("ASMT-002").clock.now);

let c0: Church;
let clockMs = NOW;
const clock = { now: () => new Date(clockMs).toISOString() as never };
const job = createAssessmentJob({ clock });
const assessments = createAssessments({ clock });
const scripted = (options: Parameters<typeof scriptedAssessmentDrafter>[0] = {}) =>
	scriptedAssessmentDrafter(options.during ? { ...options, during: AsyncResource.bind(options.during) } : options);

before(async () => {
	c0 = await church("asmtc", { clock: new Date(NOW - HOUR) });
	await c0.release("methodology-2026.10");
});
after(() => c0?.database.close());

const iso = (at: string | number) => new Date(at).toISOString();
type Run = StoredRun & { retry_at: string | null; deadline_at: string; demand_key: string; captured_at: string };
const runs = (p: { id: string }) =>
	c0.rows<Run>(sql`SELECT id,outcome,reason,demand,demand_key,as_of,source_revision,reference_activation,result,facts,
		model_input,attempts,input_tokens,output_tokens,pending_attempts,drafts,retry_at,deadline_at,delta,captured_at
		FROM assessment_run WHERE plant_id=${p.id} ORDER BY captured_at,id`);
const jobs = (p: { id: string }) =>
	c0.rows<{ producer_key: string; state: string }>(sql`SELECT producer_key,state FROM job WHERE kind='assessment'
		AND subject_record_id=${p.id} ORDER BY eligible_at,id`);
const view = async (p: { actor: RequestActor }) => ok(await assessments.readAssessment(c0.db, p.actor, {}));
const isolate = (p: { id: string }) =>
	c0.admin.execute(sql`UPDATE job SET state='cancelled',finished_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL,
		next_attempt_at=NULL WHERE kind='assessment' AND subject_record_id<>${p.id} AND state IN ('ready','retry_wait','claimed')`);
const batch = async (p: { id: string }, drafter = scripted(), limit = 1) => {
	await isolate(p);
	return runAssessmentBatch(job, c0.db, drafter, limit);
};
const refresh = async (p: ChurchPlant, drafter = scripted(), limit = 1) => {
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await batch(p, drafter, limit);
	return (await runs(p)).at(-1)!;
};
const inputState = async (p: { id: string }) => (await captureFacts(c0.db, p.id, clock.now()))!.sourceRevision;
const audits = async (p: { id: string }) =>
	(await c0.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${p.id}`)).n;
const releases = async (p: { id: string }) =>
	(
		await c0.one<{ n: number }>(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${p.id} AND action='intelligence.released'`,
		)
	).n;
async function tick(p: { id: string }, drafter = scripted()) {
	await isolate(p);
	const response = await scheduledJobs({
		db: c0.db,
		storage: null,
		cleanup: null,
		effects: null,
		digests: null,
		mail: null,
		assessments: { drafter },
		now: () => new Date(clockMs),
	})();
	const body = await response.json();
	assert.equal(body.steps.assessment.status, "ok", JSON.stringify(body.steps));
	await batch(p, drafter, 20);
}
async function assessed(name: string, options: { network?: { id: string } } = {}) {
	const p = await c0.harvest(name, options);
	assert.equal((await refresh(p)).outcome, "published", "R0 published");
	return p;
}
const invalid = (options: Parameters<typeof scriptedAssessmentDrafter>[0] = {}) =>
	scripted({ ...options, script: (d) => ({ ...d, focus: { ...d.focus, citations: [] } }) });
const once = (body: () => Promise<unknown>) => {
	let done = false;
	return async () => {
		if (done) return;
		done = true;
		await body();
	};
};
const dbNow = async () => (await c0.one<{ t: string }>(sql`SELECT clock_timestamp() AS t`)).t;

test("AC:ASMT-001 with no write after R1 the scheduler owes nothing for six days; the first tick on the eighth day queues one new daily demand whose run takes that instant as its as-of, with R1's source revision and reference activation", async (t) => {
	const k = K("ASMT-001");
	const e = k.expected.result as Record<string, unknown>;
	assert.equal(k.action.operation, "intelligence.scheduleAssessment");
	const main = c0;
	c0 = await church("asmtq", { clock: new Date(R1_AS_OF - HOUR) });
	t.after(async () => {
		await c0.database.close();
		c0 = main;
		clockMs = NOW;
	});
	await c0.release("methodology-2026.10");
	clockMs = R1_AS_OF;
	const p = await c0.harvest("Quiet Day Eight");
	await tick(p);
	const r1 = (await runs(p)).at(-1)!;
	assert.deepEqual([r1.outcome, r1.demand, iso(r1.as_of)], ["published", "time", iso(R1_AS_OF)], "R1 at its as-of");
	assert.equal(given(k, "source"), e.source_revision, "the case keeps R1's source label");
	assert.equal(given(k, "ref"), e.reference_activation, "and R1's reference label");
	const writes = await audits(p);
	const quietUntil = Date.parse(`${given<string>(k, "no_writes_until")}T00:00:00Z`);
	for (let day = 1; day < ASSESSMENT_TIMING.staleDays; day++) {
		clockMs = R1_AS_OF + day * DAY;
		await tick(p);
		assert.equal((await runs(p)).length, 1, `${iso(clockMs)}: a quiet plant under seven days owes nothing`);
		assert.equal((await jobs(p)).length, 1, `${iso(clockMs)}: and queues no demand`);
	}
	clockMs = quietUntil;
	await tick(p);
	const demands = (await jobs(p)).map((j) => j.producer_key);
	assert.deepEqual(demands, [r1.demand_key, `time/${iso(quietUntil).slice(0, 10)}`], "one new daily demand");
	assert.equal(e.new_daily_demand, demands.length === 2 && demands[1] !== r1.demand_key);
	const all = await runs(p);
	assert.equal(all.length, 2);
	const r2 = all[1]!;
	assert.deepEqual([r2.outcome, r2.demand], ["published", "time"]);
	assert.equal(iso(r2.as_of), iso(e.new_run_as_of as string), "the new run's as-of is the day-eight tick's instant");
	assert.equal(r2.source_revision, r1.source_revision, "the unchanged source revision");
	assert.equal(Number(r2.reference_activation), Number(r1.reference_activation), "the unchanged reference activation");
	assert.equal(await releases(p), 1, "R1's one 72-hour release to oversight");
	assert.equal(await audits(p), writes + 1 + 1, "only R1's release and the new run's audit: no write in between");
	const v = await view(p);
	assert.deepEqual([v.current!.runId, v.current!.asOf, v.current!.ageDays], [r2.id, iso(quietUntil), 0]);
	await tick(p);
	assert.equal((await jobs(p)).length, 2, "a second tick the same day queues nothing more");
	assert.equal(k.expected.event, null);
});

test("AC:ASMT-002 INV-freshness: a correction that commits after capture with the wake-up paused settles the run superseded and R0 stays; the next sweep queues the corrected source and publishes it", async () => {
	const k = K("ASMT-002");
	const e = k.expected.result as Record<string, unknown>;
	assert.deepEqual([given(k, "outbox"), k.action.arguments.outbox], ["paused", "paused"]);
	clockMs = NOW;
	const p = await assessed("Paused Outbox");
	const r0 = (await view(p)).current!;
	const r0Run = (await runs(p)).at(-1)!;
	clockMs += 1000;
	const card = await c0.one<{ id: string; revision: string }>(sql`SELECT id,revision::text FROM commitment
		WHERE plant_id=${p.id} ORDER BY id LIMIT 1`);
	const raced = await refresh(
		p,
		scripted({
			during: once(async () => {
				ok(
					await withPeopleWrite(c0.db, p.actor, (t, ctx) =>
						commitments.correctCommitmentLifecycle(t as never, ctx as never, {
							requestKey: randomUUID(),
							expectedRevision: card.revision,
							input: {
								commitmentId: card.id,
								correction: { action: "correct", occurredOn: c0.day(-45) },
								reason: "Read the card again",
							},
						}),
					),
				);
			}),
		}),
	);
	assert.equal(raced.source_revision, r0Run.source_revision, "captured at R0's source state");
	assert.deepEqual([raced.outcome, raced.reason, raced.result], [e.status, "changed_input", null]);
	assert.equal(e.prior_result, "R0");
	assert.equal((await view(p)).current!.runId, r0.runId, "R0 stays current");

	await c0.admin.execute(sql`DELETE FROM job WHERE kind='assessment' AND subject_record_id=${p.id}
		AND producer_key=${"followup/" + raced.id}`);
	assert.deepEqual(
		(await jobs(p)).filter((x) => x.state === "ready"),
		[],
		"the wake-up is paused: nothing owed is queued",
	);
	clockMs += 1000;
	const corrected = await inputState(p);
	assert.notEqual(corrected, raced.source_revision, "the correction moved the source");
	await isolate(p);
	await job.scheduleAssessments(c0.db, 500);
	const swept = (await jobs(p)).filter((x) => x.state === "ready").map((x) => x.producer_key.split("/")[0]);
	assert.deepEqual(swept, ["change"], "the sweep finds the lost work");
	assert.equal((await view(p)).current!.runId, r0.runId);
	await batch(p);
	const next = (await runs(p)).at(-1)!;
	assert.deepEqual([next.outcome, next.demand, next.source_revision], ["published", "change", corrected]);
	assert.equal(k.expected.event, null);
});

test("AC:ASMT-003 a training assignment, a contact or an attendance correction committed while the draft is in flight supersedes the run; the follow-up run publishes every fact from one snapshot", async () => {
	const k = K("ASMT-003");
	const e = k.expected.result as Record<string, unknown>;
	const mutations = given<string[]>(k, "mutations");
	clockMs = NOW;
	const p = await assessed("Mill Road");
	const r0Run = (await runs(p)).at(-1)!;
	const adults = await c0.rows<{ id: string }>(sql`SELECT person_id AS id FROM commitment WHERE plant_id=${p.id}
		ORDER BY person_id`);
	const held = await c0.one<{ id: string; person: string }>(sql`SELECT m.id,pa.person_id AS person FROM meeting m
		JOIN participation pa ON pa.meeting_id=m.id AND pa.presence='attended' WHERE m.plant_id=${p.id} LIMIT 1`);
	const program = (
		await c0.one<{ id: string }>(sql`INSERT INTO training_program(plant_id,name,required)
			VALUES(${p.id},'Mid-draft course',true) RETURNING id`)
	).id;
	const obligation = randomUUID();
	const task = randomUUID();
	for (const [id, kind] of [
		[obligation, "obligation"],
		[task, "task"],
	] as const)
		await c0.admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${id},${kind},${p.id})`);
	await c0.admin
		.execute(sql`INSERT INTO obligation(id,plant_id,meeting_id,person_id,kind,origin_at,origin_date,timezone,
		formula_version,due_date) VALUES(${obligation},${p.id},${held.id},${adults[1]!.id},'follow_up',
		clock_timestamp()-interval '72 hours',${c0.day(-3)},'America/Chicago','f1',${c0.day(-1)})`);
	await c0.admin
		.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,obligation_id,
		person_id) VALUES(${task},${p.id},'Call the guest','follow_up','medium','not_started',
		clock_timestamp()-interval '72 hours','undated',${obligation},${adults[1]!.id})`);
	const followups = createFollowUpWriter({ reminders: (async () => {}) as never });
	const attendance = createAttendanceWriter({ reminders: async () => {} });
	const at = await dbNow();
	const mutate: Record<string, () => Promise<unknown>> = {
		training_assignment: () =>
			c0.admin.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
				VALUES(${p.id},${program},${adults[0]!.id},1,'active',${c0.day(-1)})`),
		contact: async () => {
			const { revision: taskRevision } = await c0.one<{ revision: string }>(
				sql`SELECT revision::text AS revision FROM task WHERE id=${task}`,
			);
			return ok(
				await withFollowUpWrite(c0.db, p.actor, (tx, ctx) =>
					followups.recordOutcome(tx, ctx, {
						requestKey: randomUUID(),
						input: {
							target: { kind: "task", taskId: task, expectedRevision: taskRevision },
							outcome: "contacted",
							occurredAt: iso(Date.parse(at) - HOUR),
							completeTask: false,
						},
					}),
				),
			);
		},
		attendance_correction: async () =>
			ok(
				await withMeetingsWrite(c0.db, p.actor, (tx, ctx) =>
					attendance.clearAttendance(tx, ctx, {
						requestKey: randomUUID(),
						input: { meetingId: held.id, personId: held.person },
					}),
				),
			),
	};
	assert.deepEqual(Object.keys(mutate), mutations);
	assert.ok(r0Run.source_revision);
	for (const m of mutations) {
		clockMs += 1000;
		const captured = await inputState(p);
		const prior = (await view(p)).current!.runId;
		const raced = await refresh(p, scripted({ during: once(mutate[m]!) }));
		assert.equal(raced.source_revision, captured, `${m}: captured before the mutation`);
		const live = await inputState(p);
		assert.notEqual(live, raced.source_revision, `${m}: the mutation moved the live input`);
		assert.deepEqual([raced.outcome, raced.reason, raced.result], [e.status, "changed_input", null], m);
		assert.equal((await view(p)).current!.runId, prior, `${m}: the superseded run is never current`);
		await batch(p);
		const newer = (await runs(p)).at(-1)!;
		assert.deepEqual([newer.outcome, newer.demand], ["published", "followup"], m);
		const snapshot = (await captureFacts(c0.db, p.id, iso(newer.as_of) as never))!;
		assert.equal(newer.source_revision, snapshot.sourceRevision, `${m}: one snapshot at the run's as-of`);
		assert.deepEqual(newer.facts, JSON.parse(JSON.stringify(snapshot)), `${m}: every stored fact from it`);
		assert.deepEqual(newer.model_input!.facts, c.factCatalog(newer.facts), `${m}: every model fact from it`);
		const mixed = newer.source_revision !== snapshot.sourceRevision;
		assert.equal(mixed, e.mixed_snapshot);
		assert.equal((await view(p)).current!.runId, newer.id);
	}
	assert.equal(k.expected.event, null);
});

test("AC:ASMT-004 a worker whose claim generation was replaced cannot publish with unchanged data; the next generation resumes the same run and publishes once, and the published row never moves", async () => {
	const k = K("ASMT-004");
	const e = k.expected.result as Record<string, unknown>;
	assert.equal(given(k, "new_generation"), given<number>(k, "previous_worker_identity") + 1);
	clockMs = NOW;
	const p = await assessed("Lake Shore");
	const requestId = randomUUID();
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId }));
	const generation = async () =>
		Number(
			(
				await c0.one<{ g: string }>(sql`SELECT claim_generation::text AS g FROM job WHERE kind='assessment'
					AND subject_record_id=${p.id} AND producer_key=${"manual/" + requestId}`)
			).g,
		);
	const row = (id: string) =>
		c0.one(sql`SELECT outcome,result,delta,available_at::text,settled_at::text,attempts,drafts FROM assessment_run
			WHERE id=${id}`);
	const second = scripted();
	let stale = 0;
	let fresh = 0;
	let publishedByFresh: Record<string, unknown> | null = null;
	const first = scripted({
		during: once(async () => {
			stale = await generation();
			clockMs += ASSESSMENT_TIMING.leaseMs + 1000;
			assert.equal(await runAssessmentBatch(job, c0.db, second, 1), 1, "the expired claim is taken over");
			fresh = await generation();
			const r = (await runs(p)).at(-1)!;
			publishedByFresh = await row(r.id);
		}),
	});
	await batch(p, first);
	assert.equal(fresh, stale + 1, "generation 5 replaced generation 4");
	const all = await runs(p);
	const run = all.at(-1)!;
	assert.equal(all.length, 2, "one run for the demand");
	assert.equal(run.source_revision, await inputState(p), "the source never changed");
	assert.equal(given(k, "source_unchanged"), true);
	assert.equal((publishedByFresh as unknown as { outcome: string }).outcome === "published", e.generation5_publish);
	assert.deepEqual(await row(run.id), publishedByFresh, "the stale worker changed nothing on the published row");
	const audited = await c0.rows(sql`SELECT 1 FROM audit_event WHERE event_key=${"assessment:" + run.id}`);
	assert.equal(audited.length === 2, e.generation4_publish, "published once, by generation 5 only");
	assert.equal(audited.length, 1);
	const points = 3 + run.result!.draft.positives.length;
	assert.equal((await c0.rows(sql`SELECT 1 FROM assessment_insight WHERE run_id=${run.id}`)).length, points);
	assert.deepEqual([run.outcome, run.attempts, first.calls.length, second.calls.length], ["published", 2, 1, 1]);
	const pointers = await c0.rows(sql`SELECT id FROM assessment_run WHERE plant_id=${p.id} AND outcome='published'`);
	assert.equal(pointers.length === 2 && e.mutable_result_pointer === false, true, "two immutable published rows");
	assert.equal((await view(p)).current!.runId, run.id, "the read picks the newest published row");
	assert.equal(k.expected.event, null);
});

test("AC:ASMT-005 while a newer run is pending, deferred, failed or invalid the complete R0 stays the visible result with its real as-of and age, and the newer run is its own line", async () => {
	const k = K("ASMT-005");
	const e = k.expected.result as Record<string, unknown>;
	const states = given<string[]>(k, "next_states");
	assert.equal(given(k, "complete"), "R0");
	clockMs = NOW;
	const p = await assessed("River Bend");
	const r0 = (await view(p)).current!;
	clockMs += 2 * DAY;
	const seen: Record<string, c.AssessmentView> = {};
	const failedInvalid = await refresh(
		p,
		invalid({
			during: once(async () => {
				seen.pending = await view(p);
			}),
		}),
	);
	assert.deepEqual([failedInvalid.outcome, failedInvalid.reason], ["failed", "invalid_drafts"]);
	seen.invalid = await view(p);

	const busy = scripted({ busy: [{ status: 429, retryAfterSeconds: 90 }] });
	const deferred = await refresh(p, busy);
	assert.equal(deferred.outcome, "deferred");
	seen.deferred = await view(p);
	const retryAt = iso(clockMs + 90_000);
	clockMs += 60_000;
	assert.equal(await batch(p, busy), 0, "nothing runs before the retry instant");
	clockMs += 31_000;
	const late = scripted({ busy: [{ status: 503, retryAfterSeconds: ASSESSMENT_TIMING.deadlineMs / 1000 }] });
	await batch(p, late);
	const failed = (await runs(p)).find((r) => r.id === deferred.id)!;
	assert.deepEqual([failed.outcome, failed.reason, late.calls.length], ["failed", "deadline", 1]);
	seen.failed = await view(p);

	const newest: Record<string, c.AssessmentView["newest"]> = {
		pending: { state: "preparing", retryAt: null, grounding: "grounded" },
		invalid: { state: "failed", retryAt: null, grounding: "grounded" },
		deferred: { state: "deferred", retryAt: retryAt as never, grounding: "grounded" },
		failed: { state: "failed", retryAt: null, grounding: "grounded" },
	};
	assert.deepEqual(Object.keys(seen).sort(), [...states].sort());
	for (const s of states) {
		const v = seen[s]!;
		assert.equal(v.current!.runId === r0.runId ? "R0" : v.current!.runId, e.visible_result, s);
		assert.deepEqual([v.current!.asOf, v.current!.ageDays], [r0.asOf, 2], `${s}: R0's real as-of and age`);
		assert.deepEqual(v.current, { ...r0, ageDays: 2 }, `${s}: R0 exactly as published`);
		assert.deepEqual(v.newest, newest[s], `${s}: the newer run is its own line`);
		assert.equal(v.current!.runId !== r0.runId, e.new_incomplete_replaces_prior, s);
	}
	assert.equal(k.expected.event, null);
});

test("AC:ASMT-006 an assessment-relevant updatePerson whose audit, freshness input or reported outcome fails commits nothing: the person, P's input state, audits and demands are as before", async () => {
	const k = K("ASMT-006");
	const e = k.expected.result as Record<string, unknown>;
	assert.equal(k.action.operation, "people.updatePerson");
	const faults = k.action.arguments.faults as string[];
	assert.deepEqual(faults, ["audit", "required_freshness", "reported_outcome"]);
	assert.deepEqual(given(k, "faults"), ["audit", "revision", "receipt"]);
	clockMs = NOW;
	const p = await assessed("Audit Fault");
	const who = await c0.one<{ id: string }>(sql`SELECT person_id AS id FROM commitment WHERE plant_id=${p.id}
		ORDER BY person_id LIMIT 1`);
	const person = () =>
		c0.one<{ revision: string; birth_date: string | null }>(sql`SELECT revision::text,
			birth_date::text FROM person WHERE id=${who.id}`);
	const update = async () => {
		const { revision } = await person();
		return withPeopleWrite(c0.db, p.actor, (t, ctx) =>
			peopleWriter.updatePerson(
				t as never,
				ctx as never,
				{
					requestKey: randomUUID(),
					expectedRevision: revision,
					input: { personId: who.id, patch: { birthDate: "2015-02-03" } },
				} as never,
			),
		);
	};
	const trigger: Record<string, string> = {
		audit: `BEFORE INSERT ON audit_event FOR EACH ROW WHEN (NEW.tenant_id='${p.id}' AND NEW.action NOT LIKE 'intelligence.%')`,
		required_freshness: `BEFORE UPDATE ON person FOR EACH ROW WHEN (NEW.id='${who.id}' AND NEW.revision<>OLD.revision)`,
		reported_outcome: `BEFORE INSERT ON audit_event FOR EACH ROW WHEN (NEW.tenant_id='${p.id}' AND NEW.request_key IS NOT NULL
			AND NEW.result IS NOT NULL)`,
	};
	const table: Record<string, string> = {
		audit: "audit_event",
		required_freshness: "person",
		reported_outcome: "audit_event",
	};
	const state = async () => ({
		input: await inputState(p),
		person: await person(),
		audits: await audits(p),
		jobs: await jobs(p),
		current: (await view(p)).current!.runId,
	});
	const before = await state();
	for (const fault of faults) {
		const name = `asmt006_${fault}`;
		await c0.admin.execute(
			sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION '${name}'; END$$`),
		);
		await c0.admin.execute(sql.raw(`CREATE TRIGGER ${name} ${trigger[fault]} EXECUTE FUNCTION ${name}()`));
		let outcome: unknown;
		try {
			outcome = await update();
		} catch (error) {
			outcome = error;
		} finally {
			await c0.admin.execute(sql.raw(`DROP TRIGGER ${name} ON ${table[fault]}; DROP FUNCTION ${name}()`));
		}
		assert.ok(
			outcome instanceof Error || (outcome as { status?: string }).status === "refused",
			`${fault}: the write fails (${JSON.stringify(outcome)})`,
		);
		const after = await state();
		assert.deepEqual(after, before, `${fault}: no partial commit`);
		assert.equal(after.input !== before.input, e.partial_fact_commit, `${fault}: P's input state is as before`);
		assert.equal(
			e.assessment_input_state_after_failure,
			(k.given.P as { assessment_input_state: string }).assessment_input_state,
		);
		await isolate(p);
		await job.scheduleAssessments(c0.db, 500);
		assert.deepEqual(await jobs(p), before.jobs, `${fault}: the sweep finds no change`);
	}
	ok(await update());
	assert.notEqual(await inputState(p), before.input, "the same write without a fault moves P's input");
	assert.equal(k.expected.event, null);
});

test("AC:ASMT-007 a run captured at activation 1 is refused after activation 2, and after a rollback that is activation 3 of activation 1's own release", async () => {
	const k = K("ASMT-007");
	const e = k.expected.result as Record<string, unknown>;
	const [one, two, three] = ["run_activation", "new_activation", "rollback_activation"].map((n) => given<number>(k, n));
	clockMs = NOW;
	const p = await assessed("Hill Top");
	const q = await assessed("Hill Bottom");
	const activation = async () =>
		Number((await c0.one<{ n: string }>(sql`SELECT max(activation_number)::text AS n FROM reference_activation`)).n);
	assert.equal(await activation(), one);
	const first = await c0.one<{ id: string }>(sql`SELECT release_id AS id FROM reference_activation
		WHERE activation_number=${one}`);
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	ok(await assessments.requestRefresh(c0.db, q.actor, { requestId: randomUUID() }));
	let qSettledAt = 0;
	const pDrafter = scripted({
		during: once(async () => {
			assert.equal(
				await runAssessmentBatch(
					job,
					c0.db,
					scripted({
						during: once(async () => {
							await c0.release("methodology-2026.11");
						}),
					}),
					1,
				),
				1,
			);
			qSettledAt = await activation();
			await c0.activate(first.id);
		}),
	});
	await c0.admin.execute(sql`UPDATE job SET state='cancelled',finished_at=clock_timestamp() WHERE kind='assessment'
		AND subject_record_id NOT IN (${p.id},${q.id}) AND state IN ('ready','retry_wait','claimed')`);
	await runAssessmentBatch(job, c0.db, pDrafter, 1);
	const qRun = (await runs(q)).at(-1)!;
	const pRun = (await runs(p)).at(-1)!;
	assert.equal(qSettledAt, two);
	assert.deepEqual(
		[Number(qRun.reference_activation), qRun.outcome, qRun.reason],
		[one, "superseded", "changed_reference"],
	);
	assert.equal(qRun.outcome === "published", e.activation1_publish_after2);
	assert.equal(await activation(), three);
	const rolledBack = await c0.one<{ id: string }>(sql`SELECT release_id AS id FROM reference_activation
		WHERE activation_number=${three}`);
	assert.equal(rolledBack.id, first.id, "activation 3 is activation 1's release");
	assert.deepEqual(
		[Number(pRun.reference_activation), pRun.outcome, pRun.reason],
		[one, "superseded", "changed_reference"],
	);
	assert.equal(pRun.outcome === "published", e.activation1_publish_after3);
	for (const x of [p, q]) assert.notEqual((await view(x)).current!.runId, (await runs(x)).at(-1)!.id);
	assert.equal(await runAssessmentBatch(job, c0.db, scripted(), 2), 2, "each follow-up demand runs");
	for (const x of [p, q]) {
		const next = (await runs(x)).at(-1)!;
		assert.deepEqual([next.outcome, Number(next.reference_activation)], ["published", three]);
	}
	assert.equal(k.expected.event, null);
});

test("AC:ASMT-008 when contributor Q turns findings off, turns a category off or ends its affiliation before the organization publishes and reads, no pattern built on Q shows, an ended Q has no row and findings off read Not shared", async () => {
	const k = K("ASMT-008");
	const e = k.expected.result as Record<string, unknown>;
	assert.deepEqual(given(k, "contributors"), ["P", "Q"]);
	const changes = given<string[]>(k, "Q_changed");
	const change: Record<string, (affiliation: string) => ReturnType<typeof sql>> = {
		findings_OFF: (a) => sql`UPDATE affiliation SET shared_findings=false WHERE id=${a}`,
		category_OFF: (a) => sql`UPDATE affiliation SET share_ministry_teams=false WHERE id=${a}`,
		ended_affiliation: (a) => sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${a}`,
	};
	assert.deepEqual(Object.keys(change), changes);
	clockMs = NOW;
	for (const what of changes) {
		const network = await c0.database.organization("sending_network", {
			name: `Prairie ${what}`,
			timezone: "America/Chicago",
		});
		const seat = await c0.database.actor(network, "admin");
		const director = (await RequestActor.resolve(c0.db, seat.session as never)) as RequestActor;
		const P = await c0.harvest(`Prairie ${what} P`, { network });
		const Q = await c0.harvest(`Prairie ${what} Q`, { network });
		await c0.admin.execute(
			sql`UPDATE plant SET timezone=${(k.given.Q as { timezone: string }).timezone} WHERE id=${Q.id}`,
		);
		let released = "";
		for (const x of [P, Q]) {
			await c0.admin.execute(sql`UPDATE affiliation SET share_people=true,share_meetings=true,share_tasks=true,
				share_ministry_teams=true WHERE id=${x.affiliation}`);
			const r = await refresh(x);
			assert.equal(r.outcome, "published");
			ok(await createAssessments().markAssessmentSeen(c0.db, x.actor, { runId: r.id }));
			released = r.id;
		}
		const read = async (runId: string | null) =>
			(await readIntelligence(c0.db, director, { level: "portfolio", runId }))!;
		const earlier = randomUUID();
		ok(await requestIntelligenceRefresh(c0.db, director, { runId: earlier }));
		const before = await read(earlier);
		const onQ = (v: typeof before) =>
			v.groups.flatMap((g) => g.patterns).filter((x) => x.plants.some((pl) => pl.plantId === Q.id));
		assert.ok(onQ(before).length > 0, `${what}: with both shared a pattern is built on P and Q`);
		if (what === "category_OFF")
			assert.ok(
				onQ(before).some((x) => "lens" in x && x.lens === "leadership"),
				"with both shared a ministry-team pattern is built on P and Q",
			);
		assert.ok(onQ(before).every((x) => x.plants.some((pl) => pl.plantId === P.id)));

		const raced = await refresh(
			Q,
			scripted({
				during: once(async () => {
					await c0.admin.execute(change[what]!(Q.affiliation!));
				}),
			}),
		);
		assert.equal(raced.outcome, "published", `${what}: Q still publishes its own assessment`);
		const latest = randomUUID();
		ok(await requestIntelligenceRefresh(c0.db, director, { runId: latest }));
		for (const v of [await read(latest), await read(earlier)]) {
			const ministry = (x: ReturnType<typeof onQ>[number]) =>
				"lens" in x && x.lens
					? (c.LENSES.find((l) => l.key === x.lens)?.facts ?? []).some((f) => f === "coverage" || f === "training")
					: x.rule === "NIR-03" || x.rule === "NIR-06";
			const invalid = onQ(v).filter((x) => what !== "category_OFF" || ministry(x));
			assert.equal(
				invalid.length > 0,
				e.invalid_pattern_visible,
				`${what}: no pattern built on Q's withdrawn evidence`,
			);
			const rows = v.groups.flatMap((g) => g.rows).filter((r) => r.plantId === Q.id);
			if (what === "ended_affiliation") assert.equal(rows.length > 0, e.ended_row_visible, "an ended Q has no row");
			else assert.equal(rows.length, 1);
			if (what === "findings_OFF") {
				assert.equal(e.shared_findings_OFF_label, "Not shared");
				assert.deepEqual(rows, [{ status: "not_shared", plantId: Q.id, name: Q.name }]);
			}
			if (what === "category_OFF") {
				const row = rows[0] as Extract<(typeof rows)[number], { status: "shared" }>;
				assert.equal(row.status, "shared");
				assert.equal(JSON.stringify(row.assessment).includes("coverage."), false, "no ministry-team finding");
			}
			if (what !== "category_OFF")
				for (const id of [released, raced.id])
					assert.equal(JSON.stringify(v).includes(id), false, `${what}: no Q result`);
		}
	}
	assert.equal(k.expected.event, null);
});

test("AC:ASMT-009 INV-freshness: two connections commit people, attendance and training changes while a capture waits with its snapshot open; the run holds one snapshot, never a mix of old and new", async () => {
	const k = K("ASMT-009");
	const e = k.expected.result as Record<string, unknown>;
	assert.equal(given(k, "separate_connections"), 2);
	assert.deepEqual(given(k, "sources"), ["people", "attendance", "training"]);
	clockMs = NOW;
	const p = await assessed("One Snapshot");
	const held = await c0.one<{ id: string }>(sql`SELECT id FROM meeting WHERE plant_id=${p.id}`);
	const trainee = await c0.committed(p, "Trainee", 20);
	const newcomer = await c0.person(p, "Newcomer");
	const program = (
		await c0.one<{ id: string }>(sql`INSERT INTO training_program(plant_id,name,required)
			VALUES(${p.id},'Snapshot course',true) RETURNING id`)
	).id;
	await c0.admin.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
		VALUES(${p.id},${program},${trainee.id},1,'active',${c0.day(-5)})`);
	clockMs += 1000;
	const old = (await captureFacts(c0.db, p.id, clock.now()))!;
	const attendance = createAttendanceWriter({
		reminders: async () => {
			throw Error("unexpected task reminder replan");
		},
	});
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await isolate(p);
	const before = (await runs(p)).length;

	const written = Promise.withResolvers<void>();
	const go = Promise.withResolvers<void>();
	const locked = Promise.withResolvers<number>();
	const release = Promise.withResolvers<void>();
	const gate = c0.admin.transaction(async (tx) => {
		await tx.execute(sql`LOCK TABLE four_cs IN ACCESS EXCLUSIVE MODE`);
		locked.resolve((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
		await release.promise;
	});
	const blocker = await locked.promise;
	const firstConnection = gatedTransaction(c0.db, async (tx) => {
		const signed = ok(
			await commitments.createCommitment(tx, p.ctx as never, {
				requestKey: randomUUID(),
				input: { personId: newcomer.id, kind: "core_group", occurredOn: c0.day(-1) },
			}),
		);
		await tx.execute(sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on)
			VALUES(${p.id},${trainee.id},${program},'earned',1,${c0.day(-1)})`);
		written.resolve();
		await go.promise;
		return signed;
	});
	await written.promise;
	const secondConnection = withMeetingsWrite(c0.db, p.actor, (tx, ctx) =>
		attendance.checkIn(tx, ctx, { requestKey: randomUUID(), input: { meetingId: held.id, personId: trainee.id } }),
	);
	const capture = runAssessmentBatch(job, c0.db, scripted(), 1);
	try {
		await waitingOnLock(c0.admin, { blockedBy: blocker });
		go.resolve();
		await firstConnection;
		ok(await secondConnection);
	} finally {
		go.resolve();
		release.resolve();
		await gate;
	}
	await capture;
	const all = await runs(p);
	const raced = all.at(-1)!;
	const now = (await captureFacts(c0.db, p.id, iso(raced.as_of) as never))!;
	assert.equal(raced.source_revision, now.sourceRevision, "all three changes, in one snapshot");
	assert.notEqual(now.sourceRevision, old.sourceRevision);
	assert.deepEqual(
		[
			raced.facts.committedAdults.known + raced.facts.committedAdults.needsClassifying.length,
			raced.facts.vision.lastAttendance,
			raced.facts.training.complete,
		],
		[old.committedAdults.known + 1, [old.vision.lastAttendance[0]! + 1], old.training.complete + 1],
	);
	assert.deepEqual(raced.facts, JSON.parse(JSON.stringify(now)), "the stored facts are that one snapshot");
	assert.deepEqual(raced.model_input!.facts, c.factCatalog(raced.facts), "every model fact comes from it");
	assert.equal(raced.source_revision !== now.sourceRevision, e.mixed_snapshot);
	assert.equal(all.length - before, e.snapshot_count, "the raced capture attempt left no run of its own");
	assert.equal(raced.outcome, "published");
	assert.equal(k.expected.event, null);
});

test("AC:ASMT-012 saving or correcting a private check-in leaves P's assessment input state as it was, queues no assessment demand and writes no audit row", async () => {
	const k = K("ASMT-012");
	const e = k.expected.result as Record<string, unknown>;
	assert.equal(k.action.operation, "privateCare.save");
	clockMs = NOW;
	const p = await assessed("Willow Park");
	const care = createPrivateCare();
	const before = {
		input: await inputState(p),
		runs: await runs(p),
		jobs: await jobs(p),
		audits: await audits(p),
	};
	const answers = { spiritual: "steady", family: "strained", financial: "steady", pace: "strained" };
	const current = ok(await care.readCurrent(c0.db, p.actor, {}));
	const actions: Record<string, () => Promise<unknown>> = {
		save: async () =>
			ok(
				await care.save(c0.db, p.actor, {
					requestKey: randomUUID(),
					expectedRevision: current.revision,
					input: { answers, note: "a private note" },
				}),
			),
		correct: async () => {
			const again = ok(await care.readCurrent(c0.db, p.actor, {}));
			return ok(
				await care.correct(c0.db, p.actor, {
					requestKey: randomUUID(),
					expectedRevision: again.revision,
					input: { weekId: again.week.id, answers: { ...answers, pace: "steady" }, note: "corrected" },
				}),
			);
		},
	};
	for (const [action, run] of Object.entries(actions)) {
		await run();
		assert.equal(await inputState(p), before.input, `${action}: the input state is as before`);
		assert.equal(e.assessment_input_state, k.action.arguments.before_assessment_input_state);
		assert.equal((await audits(p)) - before.audits, e.broad_audit_rows, `${action}: no audit row`);
		await isolate(p);
		await job.scheduleAssessments(c0.db, 500);
		assert.equal((await jobs(p)).length - before.jobs.length, e.PI_demands, `${action}: no assessment demand`);
	}
	await batch(p, scripted(), 20);
	assert.deepEqual(await runs(p), before.runs, "no run");
	assert.equal(k.expected.event, null);
});

test("AC:PI-URGENCY-001 model urgencies positive, info, watch and urgent persist as info, low, medium and high; publication ranks no plant; a new critical output is refused and publishes nothing", async () => {
	const k = K("PI-URGENCY-001");
	const e = k.expected.result as Record<string, unknown>;
	const urgencies = given<c.Urgency[]>(k, "modelUrgencies");
	const old = given<string[]>(k, "oldStoredLabels");
	clockMs = NOW;
	const p = await assessed("Urgency Grove");
	const tables = (
		await c0.rows<{ t: string }>(sql`SELECT table_name AS t FROM information_schema.tables
			WHERE table_schema=current_schema() AND table_type='BASE TABLE' ORDER BY 1`)
	).map((r) => r.t);
	const census = async () => {
		const out: Record<string, number> = {};
		for (const t of tables)
			out[t] = (await c0.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)}`)).n;
		return out;
	};
	const [positive, info, watch, urgent] = urgencies;
	const mixed = scripted({
		script: (d) => ({
			...d,
			focus: { ...d.focus, urgency: urgent! },
			supporting: [
				{ ...d.supporting[0], urgency: watch! },
				{ ...d.supporting[1], urgency: info! },
			],
			positives: d.positives.map((x) => ({ ...x, urgency: positive! })),
		}),
	});
	clockMs += 1000;
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await isolate(p);
	const before = await census();
	await runAssessmentBatch(job, c0.db, mixed, 1);
	const after = await census();
	const run = (await runs(p)).at(-1)!;
	assert.equal(run.outcome, "published");
	assert.ok(run.result!.draft.positives.length > 0, "the draft has a positive point");
	const stored = await c0.rows<{ role: string; severity: string }>(sql`SELECT role,severity FROM assessment_insight
		WHERE run_id=${run.id} ORDER BY ordinal`);
	assert.deepEqual(
		stored.map((s) => s.severity),
		[urgent, watch, info, ...run.result!.draft.positives.map(() => positive)].map((u) => c.SEVERITY[u!]),
	);
	const persisted = [...new Set(stored.map((s) => s.severity))].sort((a, b) => old.indexOf(a) - old.indexOf(b));
	assert.deepEqual(persisted, e.persisted_labels);
	assert.deepEqual(
		urgencies.map((u) => c.SEVERITY[u]),
		e.persisted_labels,
	);
	assert.ok(!stored.some((s) => s.severity === given(k, "unapprovedNewOutput")));
	const changed = tables.filter((t) => after[t] !== before[t]);
	assert.deepEqual(
		changed,
		["assessment_insight", "assessment_run", "audit_event", "record"],
		"the run, its insights, their record ids and its audit row only",
	);
	assert.equal(
		changed.some((t) => /rank/.test(t)),
		e.plant_ranking_created,
	);
	const v = (await view(p)).current!;
	assert.deepEqual(
		v.insights.map((i) => i.severity),
		["high", "medium", "low", ...run.result!.draft.positives.map(() => "info")],
		"severity orders the insights within this one result",
	);

	const sub = k.subcases!.find((s) => s.name === "new-critical-refused")!;
	const se = sub.expected.result as Record<string, unknown>;
	const urgency = sub.action.arguments.model_urgency as string;
	const published = async () =>
		(
			await c0.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM assessment_run WHERE plant_id=${p.id}
			AND outcome='published'`)
		).n;
	const count = await published();
	clockMs += 1000;
	const refused = await refresh(p, scripted({ script: (d) => ({ ...d, focus: { ...d.focus, urgency } }) as never }));
	assert.deepEqual([refused.outcome, refused.reason, refused.result], ["failed", "invalid_drafts", null]);
	assert.equal(se.error_code, "unsupported_urgency");
	for (const d of refused.drafts)
		assert.ok(
			d.violations.some((x) => x.rule === "shape" && /urgency/.test(JSON.stringify(x))),
			`the output check refuses urgency ${urgency}: ${JSON.stringify(d.violations)}`,
		);
	assert.equal((await published()) - count, se.published_results);
	assert.equal((await c0.rows(sql`SELECT 1 FROM assessment_insight WHERE run_id=${refused.id}`)).length, 0);
	assert.equal((await view(p)).current!.runId, run.id);
	assert.equal(k.expected.event, null);
	assert.equal((sub.expected as { event?: unknown }).event, null);
});
