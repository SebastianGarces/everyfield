import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	ASSESSMENT_TIMING,
	captureFacts,
	createAssessmentJob,
	createAssessments,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import { readIntelligence, requestIntelligenceRefresh } from "../../../packages/domain/src/oversight/intelligence.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { ok, type Actor } from "../../support/fixture.mts";
import { caseOf, type Case } from "../target/sql/core/support.mts";
import { CANARY, church, ZONE, type ChurchPlant } from "./assessment-church.mts";

type Json = Record<string, unknown>;
type WakeSubcase = Omit<NonNullable<Case["subcases"]>[number], "expected"> & {
	expected: Case["expected"] & { event: Json | null };
};
type WakeCase = Omit<Case, "expected" | "subcases"> & {
	clock: { now: string; zone: string };
	expected: Case["expected"] & { event: Json | null };
	subcases: WakeSubcase[];
};
export function wakeCase(id: string) {
	const k = caseOf("intelligence", id) as unknown as WakeCase;
	const sub = (name: string) => {
		const s = k.subcases.find((x) => x.name === name);
		assert.ok(s, `${id} ${name}`);
		return s;
	};
	return {
		...k,
		failure: sub("required-consequence-failure"),
		staleInput: sub("stale-input-publication"),
		staleClaim: sub("stale-claim-publication"),
		replay: sub("exact-replay"),
	};
}
export type LoadedWakeCase = ReturnType<typeof wakeCase>;
export function listed(facts: Json, expected: unknown) {
	const keys = Object.keys(expected as Json).filter((k) => k !== "fixture_type");
	for (const k of keys) assert.ok(k in facts, `the fact reader returns ${k}`);
	return Object.fromEntries(keys.map((k) => [k, facts[k]]));
}

export type WakeOrg = { kind: "organization"; id: string; director: Actor; reader: RequestActor };
type WakeAdmin = Actor & {
	actor: RequestActor;
	ctx: { session: Actor["session"]; selected: { kind: "plant"; id: string } };
};
export type WakePlant<T = unknown> = {
	name: string;
	P: ChurchPlant;
	Q: ChurchPlant;
	A: WakeAdmin;
	orgA: WakeOrg;
	orgB: WakeOrg;
	r0: { runId: string; sourceRevision: string };
	arranged: T;
};
type WakeSnapshot = {
	input: string;
	orgA: unknown;
	orgB: unknown;
	current: string | null;
	assessmentJobs: number;
	audits: number;
	notices: number;
};

export type Row<T> = {
	id: string;
	marker: `AC:${string} `;
	operation: string;
	producer: string;
	arrange: (w: Omit<WakePlant<T>, "r0" | "arranged">, k: LoadedWakeCase) => Promise<T>;
	facts: (w: WakePlant<T>) => Promise<Json>;
	write: (w: WakePlant<T>, k: LoadedWakeCase) => Promise<unknown>;
	action?: string;
	org?: (o: WakeOrg) => Promise<unknown>;
};
export const row = <T,>(r: Row<T>) => r as Row<unknown>;
export const strip = ({ fixture_type: _, ...rest }: Json) => rest;

export async function wakeWorld(prefix: string, at = "2026-10-13T16:00:00.000Z") {
	const c = await church(prefix, { clock: new Date(at), max: 8 });
	await c.release("methodology-2026.11");
	const { db } = c;
	let dbClockAt = 0;
	const sync = async () => {
		dbClockAt = Date.parse((await c.one<{ t: string }>(sql`SELECT clock_timestamp()::text AS t`)).t);
	};
	await sync();
	let skew = 0;
	const clock = { now: () => new Date(dbClockAt + skew).toISOString() as never };
	const job = createAssessmentJob({ clock });
	const assessments = createAssessments({ clock });
	const scripted = (options: Parameters<typeof scriptedAssessmentDrafter>[0] = {}) =>
		scriptedAssessmentDrafter(options.during ? { ...options, during: AsyncResource.bind(options.during) } : options);
	const count = async (q: ReturnType<typeof sql>) => Number((await c.one<{ n: unknown }>(q)).n);
	const keys = new Map<string, string>();
	const key = (label: string) => {
		if (!keys.has(label)) keys.set(label, randomUUID());
		return keys.get(label)!;
	};

	const isolate = (p: { id: string }) =>
		c.admin
			.execute(sql`UPDATE job SET state='cancelled',finished_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL,
			next_attempt_at=NULL WHERE kind='assessment' AND subject_record_id<>${p.id} AND state IN ('ready','retry_wait','claimed')`);
	const run = async (p: { id: string }, drafter = scripted(), limit = 20) => {
		await isolate(p);
		await sync();
		return runAssessmentBatch(job, db, drafter, limit);
	};
	const current = async (p: { actor: RequestActor }) =>
		ok(await assessments.readAssessment(db, p.actor, {})).current?.runId ?? null;
	async function publish(p: ChurchPlant, seen = true) {
		await sync();
		ok(await assessments.requestRefresh(db, p.actor, { requestId: randomUUID() }));
		await run(p);
		const now = ok(await assessments.readAssessment(db, p.actor, {})).current;
		assert.ok(now, "published");
		if (seen) ok(await assessments.markAssessmentSeen(db, p.actor, { runId: now.runId }));
		const { source_revision } = await c.one<{ source_revision: string }>(
			sql`SELECT source_revision FROM assessment_run WHERE id=${now.runId}`,
		);
		return { runId: now.runId, sourceRevision: source_revision };
	}
	async function org(name: string): Promise<WakeOrg> {
		const o = await c.database.organization("sending_network", { name, timezone: ZONE });
		const director = await c.database.actor(o, "admin");
		const reader = (await RequestActor.resolve(db, director.session)) as RequestActor;
		return { kind: "organization", id: o.id, director, reader };
	}

	const inputState = async (p: { id: string }) => (await captureFacts(db, p.id, null))!.sourceRevision;
	const orgState = (o: WakeOrg) => readIntelligence(db, o.reader, { level: "portfolio", runId: null });
	const assessmentJobs = (p: { id: string }) =>
		count(sql`SELECT count(*) AS n FROM job WHERE kind='assessment' AND subject_record_id=${p.id}`);
	const changeDemands = (p: { id: string }) =>
		c.rows<{ producer_key: string }>(sql`SELECT producer_key FROM job WHERE kind='assessment'
			AND subject_record_id=${p.id} AND producer_key LIKE 'change/%' ORDER BY eligible_at,id`);
	const sweep = async (p: { id: string }) => {
		await sync();
		await job.scheduleAssessments(db, 500);
		return changeDemands(p);
	};
	const notices = (p: { id: string }) =>
		count(sql`SELECT (SELECT count(*) FROM notice WHERE tenant_id=${p.id})+(SELECT count(*) FROM mail
			WHERE tenant_id=${p.id}) AS n`);
	const auditIds = async (p: { id: string }) =>
		new Set(
			(await c.rows<{ id: string }>(sql`SELECT id::text AS id FROM audit_event WHERE tenant_id=${p.id}`)).map(
				(r) => r.id,
			),
		);
	const auditsSince = async (p: { id: string }, before: Set<string>) =>
		(
			await c.rows<{ id: string; tenant_id: string; action: string; body: string }>(sql`SELECT id::text AS id,
				tenant_id::text AS tenant_id,action,to_jsonb(e)::text AS body FROM audit_event e WHERE tenant_id=${p.id}
				ORDER BY recorded_at,id`)
		).filter((r) => !before.has(r.id));

	async function snapshot(w: WakePlant): Promise<WakeSnapshot> {
		return {
			input: await inputState(w.P),
			orgA: await orgState(w.orgA),
			orgB: await orgState(w.orgB),
			current: await current(w.P),
			assessmentJobs: await assessmentJobs(w.P),
			audits: (await auditIds(w.P)).size,
			notices: await notices(w.P),
		};
	}

	async function plant<T>(
		name: string,
		arrange: (w: Omit<WakePlant<T>, "r0" | "arranged">) => Promise<T>,
		{ seen = true }: { seen?: boolean } = {},
	): Promise<WakePlant<T>> {
		const orgA = await org(`${name} Org-A`);
		const orgB = await org(`${name} Org-B`);
		const P = await c.plant(`${name} P`, { network: orgA });
		const Q = await c.plant(`${name} Q`, { network: orgB });
		const seat = await c.database.actor(P, "admin", { account: { personal_timezone: ZONE } });
		const A: WakeAdmin = {
			...seat,
			actor: (await RequestActor.resolve(db, seat.session)) as RequestActor,
			ctx: { session: seat.session, selected: { kind: "plant", id: P.id } },
		};
		await c.checkIn(P);
		const base = { name, P, Q, A, orgA, orgB };
		const arranged = await arrange(base);
		const r0 = await publish(P, seen);
		await publish(Q);
		for (const o of [orgA, orgB]) ok(await requestIntelligenceRefresh(db, o.reader, { runId: randomUUID() }));
		assert.equal(await inputState(P), r0.sourceRevision, "R0 was captured at P's current input state");
		assert.deepEqual(await sweep(P), [], "nothing has changed since R0");
		return { ...base, r0, arranged };
	}

	const move = (w: WakePlant, label: string) => c.committed(w.P, label, 0);

	async function withFault(w: WakePlant, body: () => Promise<unknown>, action?: string) {
		const name = `mw_fault_${randomUUID().replaceAll("-", "")}`;
		const when = action ? `AND NEW.action = '${action.replaceAll("'", "''")}'` : "";
		await c.admin.execute(
			sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS
			$$BEGIN RAISE EXCEPTION 'required_consequence_before_completion'; END$$`),
		);
		await c.admin.execute(
			sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_event FOR EACH ROW
			WHEN (NEW.tenant_id = '${w.P.id}' AND NEW.action NOT LIKE 'intelligence.%' ${when}) EXECUTE FUNCTION ${name}()`),
		);
		try {
			const outcome = await body();
			const reply = outcome as { status?: string; code?: string; error?: { code?: string } };
			if (reply?.status === "refused" && (reply.code ?? reply.error?.code) === "required_write_failed")
				return "required_write_failed";
			return outcome;
		} catch (error) {
			const text = (e: unknown): string =>
				e instanceof Error
					? `${e.message} ${text(e.cause)}`
					: e
						? String((e as { message?: string }).message ?? e)
						: "";
			if ((error as { code?: string }).code === "required_write_failed") return "required_write_failed";
			if (/required_consequence_before_completion/.test(text(error))) return "required_write_failed";
			throw error;
		} finally {
			await c.admin.execute(sql.raw(`DROP TRIGGER ${name} ON audit_event; DROP FUNCTION ${name}()`));
		}
	}

	async function requiredConsequenceFailure(
		w: WakePlant,
		k: LoadedWakeCase,
		o: { attempt: () => Promise<unknown>; facts: () => Promise<Json>; action?: string },
	) {
		const s = k.failure;
		await sync();
		assert.equal(s.action.arguments.fault, "required_consequence_before_completion");
		const before = await snapshot(w);
		assert.equal(before.input, w.r0.sourceRevision);
		assert.equal(before.current, w.r0.runId);
		assert.equal(await withFault(w, o.attempt, o.action), s.expected.result.error_code);
		const state = s.expected.state as Json;
		assert.deepEqual(listed(await o.facts(), state.facts), state.facts, "the facts are as before");
		const after = await snapshot(w);
		assert.deepEqual(after, before, "no input, organization, assessment, job, audit or notice change");
		assert.equal(after.input, w.r0.sourceRevision, "P's input state is R0's");
		assert.equal(after.current, w.r0.runId, "R0 is current");
		assert.equal(s.expected.event, null);
		assert.deepEqual(await sweep(w.P), [], "the sweep finds no change");
	}

	async function pausedWrite<R>(
		w: WakePlant,
		k: LoadedWakeCase,
		o: { write: () => Promise<R>; facts: () => Promise<Json>; replay?: () => Promise<R> },
	) {
		const e = k.expected.result as Json;
		assert.equal(k.action.arguments.wake_delivery, "paused");
		assert.equal(e.wake_delivery, "paused");
		const before = await snapshot(w);
		const ids = await auditIds(w.P);
		await sync();
		const result = await o.write();
		assert.deepEqual(listed(await o.facts(), e.facts), e.facts, "the listed facts changed");
		const after = await snapshot(w);
		assert.equal(e.current_assessment, "R0");
		assert.equal(after.current, w.r0.runId, "R0 stays current");
		const inputExpected = e.assessment_input_state;
		const inputMoves = typeof inputExpected === "object" && inputExpected !== null && "different_from" in inputExpected;
		if (inputMoves) {
			assert.notEqual(after.input, before.input, "P's assessment input state differs from R0's");
			assert.notEqual(after.input, w.r0.sourceRevision);
		} else {
			assert.equal(inputExpected, k.given.P && (k.given.P as Json).assessment_input_state);
			assert.equal(after.input, w.r0.sourceRevision, "P's assessment input state is still R0's");
		}
		assert.deepEqual(after.orgA, before.orgA, "Org-A's input state is unchanged");
		assert.deepEqual(after.orgB, before.orgB, "Org-B's input state is unchanged");
		assert.equal(after.assessmentJobs, before.assessmentJobs, "the write queues no assessment: the wake stays paused");
		assert.equal(after.notices, before.notices);
		const event = k.expected.event!;
		assert.deepEqual([event.kind, event.subject, event.private_care], ["domain_change", "P", null]);
		const events = await auditsSince(w.P, ids);
		assert.ok(events.length > 0, "the write records P's domain change");
		for (const row of events) {
			assert.equal(row.tenant_id, w.P.id);
			assert.equal(row.body.includes(CANARY), false, `${row.action} carries no private care`);
			assert.equal(/strained|struggling/i.test(row.body), false, `${row.action} carries no check-in answer`);
		}

		const r = k.replay.expected.result as Json;
		assert.equal(k.replay.action.arguments.exact_replay, true);
		assert.equal(k.replay.action.arguments.request_key, k.action.arguments.request_key);
		assert.deepEqual(await (o.replay ?? o.write)(), result, "the same recorded outcome");
		const replayed = await snapshot(w);
		assert.equal(r.additional_effects, 0);
		assert.equal(r.assessment_input_changes, 0);
		assert.deepEqual(replayed, after, "an exact replay adds no effect and no input change");
		assert.deepEqual(await auditsSince(w.P, ids), events);

		assert.equal(e.sweep_discovers_change, inputMoves);
		const demands = await sweep(w.P);
		if (inputMoves) assert.equal(demands.length, 1, "the next sweep finds the change: one change demand");
		else {
			const ran = (await runs(w.P)).length;
			await run(w.P);
			assert.equal((await runs(w.P)).length, ran, "the sweep's demand, if any, runs no assessment");
			assert.equal(await assessmentJobs(w.P), before.assessmentJobs + demands.length);
		}
		assert.equal(e.replay_new_effects, 0);
		assert.deepEqual(listed(await o.facts(), e.facts), e.facts);
		assert.equal(await current(w.P), w.r0.runId);
		return { result, input: after.input, demand: inputMoves ? demands[0]!.producer_key : null };
	}

	const runs = (p: { id: string }) =>
		c.rows<{ id: string; outcome: string; reason: string | null; source_revision: string; demand_key: string }>(
			sql`SELECT id,outcome,reason,source_revision,demand_key FROM assessment_run WHERE plant_id=${p.id}
				ORDER BY captured_at,id`,
		);
	const claimOf = async (p: { id: string }, demandKey: string) =>
		Number(
			(
				await c.one<{ g: unknown }>(sql`SELECT claim_generation AS g FROM job WHERE kind='assessment'
					AND subject_record_id=${p.id} AND producer_key=${demandKey}`)
			).g,
		);
	const settledAudits = (runId: string) =>
		count(sql`SELECT count(*) AS n FROM audit_event WHERE event_key=${"assessment:" + runId}`);

	async function stalePublications(
		w: WakePlant,
		k: LoadedWakeCase,
		captured: string,
		demand: string | null = "change",
	) {
		const r0 = w.r0.runId;
		const sent = await notices(w.P);
		for (const s of [k.staleInput, k.staleClaim]) {
			assert.equal(s.action.operation, "intelligence.publishAssessment");
			assert.deepEqual(s.expected.result, { status: "superseded", current_assessment: "R0", notice_count: 0 });
			assert.equal(s.expected.event, null);
		}
		const ia = k.staleInput.action.arguments;
		assert.notEqual(ia.captured_source, ia.live_source);

		if (!demand) ok(await assessments.requestRefresh(db, w.P.actor, { requestId: randomUUID() }));
		let moved = false;
		assert.equal(
			await run(
				w.P,
				scripted({
					during: async () => {
						if (moved) return;
						moved = true;
						await move(w, "Joined While Drafting");
					},
				}),
				1,
			),
			1,
		);
		const stale = (await runs(w.P)).at(-1)!;
		assert.ok(stale.demand_key.startsWith(demand ? "change/" : "manual/"), "the queued demand ran");
		assert.equal(stale.source_revision, captured, "captured at the write's input state");
		const live = await inputState(w.P);
		assert.notEqual(live, stale.source_revision, "the live input moved");
		assert.deepEqual([stale.outcome, stale.reason], ["superseded", "changed_input"]);
		assert.equal(await current(w.P), r0, "R0 stays current");
		assert.equal(await notices(w.P), sent, "no notice");

		const ca = k.staleClaim.action.arguments;
		assert.equal(ca.captured_source, ca.live_source);
		assert.equal(Number(ca.live_generation), Number(ca.captured_generation) + 1);
		let claimed!: () => void;
		const claimedNow = new Promise<void>((resolve) => (claimed = resolve));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let second: Promise<number> | undefined;
		let generation = 0;
		let followup = "";
		const unskewed = skew;
		let taken: Awaited<ReturnType<typeof runs>>[number];
		try {
			const first = scripted({
				during: async () => {
					if (second) return;
					followup = (
						await c.one<{ k: string }>(sql`SELECT producer_key AS k FROM job WHERE kind='assessment'
							AND subject_record_id=${w.P.id} AND state='claimed'`)
					).k;
					generation = await claimOf(w.P, followup);
					skew += ASSESSMENT_TIMING.leaseMs + 1000;
					second = runAssessmentBatch(
						job,
						db,
						scripted({
							during: async () => {
								claimed();
								await gate;
								await move(w, "Joined After Takeover");
							},
						}),
						1,
					);
					await claimedNow;
				},
			});
			assert.equal(await run(w.P, first, 1), 1);
			taken = (await runs(w.P)).at(-1)!;
			assert.equal(taken.demand_key, followup);
			assert.ok(followup.startsWith("followup/"), "the superseded run's follow-up demand");
			assert.equal(await claimOf(w.P, followup), generation + 1, "a second worker holds the live claim");
			assert.equal(taken.source_revision, await inputState(w.P), "captured and live input are the same");
			assert.equal(taken.outcome, "pending", "the stale claim's publication is refused");
			assert.equal(await settledAudits(taken.id), 0);
			assert.equal(await current(w.P), r0, "R0 stays current");
			assert.equal(await notices(w.P), sent, "no notice");
			release();
			assert.equal(await second, 1);
		} finally {
			release();
			await second?.catch(() => 0);
			skew = unskewed;
		}
		const settled = (await runs(w.P)).find((x) => x.id === taken.id)!;
		assert.deepEqual([settled.outcome, settled.reason], ["superseded", "changed_input"]);
		assert.equal(await settledAudits(taken.id), 1, "settled once under the live claim, never published");
		assert.equal(await current(w.P), r0, "R0 stays current");
		assert.equal(await notices(w.P), sent, "no notice");
		await c.admin.execute(sql`UPDATE job SET state='cancelled',finished_at=clock_timestamp(),lease_owner=NULL,
			lease_until=NULL,next_attempt_at=NULL WHERE kind='assessment' AND subject_record_id=${w.P.id}
			AND state IN ('ready','retry_wait','claimed')`);
	}

	async function runCase<R>(
		w: WakePlant,
		k: LoadedWakeCase,
		o: {
			write: () => Promise<R>;
			facts: () => Promise<Json>;
			replay?: () => Promise<R>;
			attempt?: () => Promise<unknown>;
			action?: string;
		},
	) {
		await requiredConsequenceFailure(w, k, { attempt: o.attempt ?? o.write, facts: o.facts, action: o.action });
		const done = await pausedWrite(w, k, o);
		await stalePublications(w, k, done.input, done.demand);
		return done.result;
	}

	return {
		c,
		db,
		clock,
		job,
		assessments,
		scripted,
		key,
		count,
		run,
		isolate,
		publish,
		current,
		plant,
		move,
		inputState,
		orgState,
		assessmentJobs,
		changeDemands,
		sweep,
		notices,
		auditIds,
		auditsSince,
		snapshot,
		withFault,
		requiredConsequenceFailure,
		pausedWrite,
		stalePublications,
		runCase,
		close: () => c.database.close(),
	};
}
export type WakeWorld = Awaited<ReturnType<typeof wakeWorld>>;
