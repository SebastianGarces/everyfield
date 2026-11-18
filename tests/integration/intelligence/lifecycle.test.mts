import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createSeatService } from "../../../packages/domain/src/identity/seats.ts";
import {
	ASSESSMENT_TIMING,
	captureFacts,
	createAssessmentJob,
	createAssessments,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import { sharingOperations } from "../../../packages/domain/src/organizations/sharing.ts";
import {
	readIntelligence,
	requestIntelligenceRefresh,
	submitIntelligenceFeedback,
} from "../../../packages/domain/src/oversight/intelligence.ts";
import { deletionOperations, issueRestrictedDeletionSession } from "../../../packages/domain/src/settings/index.ts";
import { eligibleOwner } from "../../../packages/domain/src/tasks/owner.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry/src/runtime/scripted-assessment.ts";
import { runDuePurges } from "../../../apps/web/src/server/jobs/lifecycle-purge.ts";
import { queueJobs } from "../../../apps/web/src/server/jobs/queue.ts";
import { ok, refused } from "../../support/fixture.mts";
import { CANARY, church, type Church } from "./assessment-church.mts";

let c0: Church;
let clockMs = Date.now();
const clock = { now: () => new Date(clockMs).toISOString() as never };
const job = createAssessmentJob({ clock });
const assessments = createAssessments({ clock });
const scripted = (options: Parameters<typeof scriptedAssessmentDrafter>[0] = {}) =>
	scriptedAssessmentDrafter(options.during ? { ...options, during: AsyncResource.bind(options.during) } : options);
const deletion = deletionOperations({
	queue: (tx, i) =>
		queueJobs(tx, [
			{
				tenant: i.subject.id,
				kind: "lifecycle_purge",
				subject: i.witnessId,
				key: `purge/${i.requestId}`,
				revision: i.revision,
				eligibleAt: i.eligibleAt,
			},
		]),
	workspaceNotice: async () => {},
});
const sharing = sharingOperations({
	invitation: async () => {},
	invalidate: () => sql`UPDATE job SET state=state WHERE false`,
});
let seats: ReturnType<typeof createSeatService>;
const storage = { bucket: "synthetic-only", client: { send: async () => ({}) } };

before(async () => {
	c0 = await church("t390l", { cleanup: true });
	await c0.release("methodology-2026.11");
	seats = createSeatService(c0.db);
});
after(() => c0?.database.close());

type Portfolio = Awaited<ReturnType<Church["portfolio"]>>;
type Plant = Portfolio["p"];
const command = (input: unknown, expectedRevision: string, requestKey: string = randomUUID()) => ({
	input,
	expectedRevision,
	requestKey,
});
async function publish(p: Plant) {
	clockMs = Date.now();
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await runAssessmentBatch(job, c0.db, scripted(), 20);
	const current = ok(await assessments.readAssessment(c0.db, p.actor, {})).current;
	assert.ok(current, "published");
	ok(await assessments.markAssessmentSeen(c0.db, p.actor, { runId: current.runId }));
	return current;
}
const portfolio = (name: string) => c0.portfolio(name, publish);
const current = async (p: { actor: RequestActor }) => ok(await assessments.readAssessment(c0.db, p.actor, {})).current;
const network = (s: Portfolio, level: "portfolio" | "region" = "portfolio", runId: string | null = null) =>
	readIntelligence(c0.db, s.director, { level, runId });
const rowsOf = (view: Awaited<ReturnType<typeof network>>) => view!.groups.flatMap((g) => g.rows);
const count = async (q: ReturnType<typeof sql>) => Number((await c0.one(q)).n);
async function witness(p: { id: string }) {
	const w =
		await c0.one(sql`SELECT state,request_id,request_revision::text AS request_revision,requested_at,cancel_until,
		cancelled_at,live_purged_at,copy_expires_at,id FROM lifecycle_witness WHERE kind='plant' AND opaque_subject_id=${p.id}`);
	for (const k of ["requested_at", "cancel_until", "cancelled_at", "live_purged_at", "copy_expires_at"])
		w[k] = w[k] === null ? null : new Date(w[k]);
	return w;
}
async function signIn(p: Plant): Promise<Plant> {
	const session = randomUUID();
	await c0.admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
		VALUES(${session},${p.owner.user},${randomBytes(32).toString("hex")},clock_timestamp()+interval '1 day')`);
	const actor = (await RequestActor.resolve(c0.db, session as never)) as RequestActor;
	return { ...p, owner: { ...p.owner, session }, actor, ctx: { ...p.ctx, session } };
}
async function requestDeletion(p: Plant) {
	const { revision } = await c0.one(sql`SELECT revision::text AS revision FROM plant WHERE id=${p.id}`);
	return ok(
		await c0.db.transaction((tx) =>
			deletion.requestWorkspaceDeletion(
				tx,
				p.ctx as never,
				command({ plant: { kind: "plant", id: p.id }, confirmed: true }, revision) as never,
			),
		),
	);
}
async function cancel(p: Plant, pending: { subject: unknown; requestId: string; revision: string }) {
	const request = { subject: pending.subject, requestId: pending.requestId };
	const handle = await c0.db.transaction((tx) =>
		issueRestrictedDeletionSession(tx, request as never, async () => ({
			accountId: p.owner.id,
			provenAt: new Date(Date.now() - 1000),
		})),
	);
	return c0.db.transaction((tx) =>
		deletion.cancelWorkspaceDeletion(tx, handle, command(request, pending.revision) as never),
	);
}
async function share(s: Portfolio, p: Plant, category: string, enabled: boolean) {
	const a = await c0.one(sql`SELECT revision::text AS revision,consent_revision::text AS consent FROM affiliation
		WHERE id=${p.affiliation}`);
	const organization = { kind: "organization", id: s.s1.id, organizationKind: "sending_network" };
	await c0.db.transaction((tx) =>
		sharing["privacy.setSharing"](
			tx,
			p.owner.session as never,
			{ kind: "plant", id: p.id } as never,
			command(
				{
					plant: { kind: "plant", id: p.id },
					organization,
					relationshipId: p.affiliation,
					expectedConsentRevision: a.consent,
					category,
					enabled,
				},
				a.revision,
			) as never,
		),
	);
}
async function graceEnds(w: { id: string }) {
	await c0.admin.transaction(async (tx) => {
		await tx.execute(sql`ALTER TABLE lifecycle_witness DISABLE TRIGGER witness_clock`);
		await tx.execute(sql`UPDATE lifecycle_witness SET requested_at=requested_at-interval '31 days',
			cancel_until=cancel_until-interval '31 days' WHERE id=${w.id}`);
		await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
		await tx.execute(sql`ALTER TABLE lifecycle_witness ENABLE TRIGGER witness_clock`);
		await tx.execute(sql`UPDATE job SET eligible_at=eligible_at-interval '31 days' WHERE kind='lifecycle_purge'
			AND subject_record_id=${w.id}`);
	});
}
const purge = () => runDuePurges(c0.db, (c0.database.pools as Record<string, any>).cleanup, storage as never, 10);
const changeDemands = (p: { id: string }) =>
	c0.rows(sql`SELECT producer_key FROM job WHERE kind='assessment' AND subject_record_id=${p.id}
		AND producer_key LIKE 'change/%' ORDER BY eligible_at,id`);
const notices = (p: { id: string }) =>
	count(sql`SELECT (SELECT count(*) FROM notice WHERE tenant_id=${p.id})+(SELECT count(*) FROM mail
		WHERE tenant_id=${p.id}) AS n`);

test("AC:TEN-007 after A's account deletion and its purge, P keeps A's shared records with only an opaque author, A's check-in is gone, P's assessment is unchanged and S1 still counts P and Q", async () => {
	const s = await portfolio("Account Purge");
	const { p, q, a } = s;
	const before = { p: await current(p), network: await network(s) };
	assert.deepEqual(
		rowsOf(before.network)
			.map((r) => r.plantId)
			.sort(),
		[p.id, q.id].sort(),
	);
	const { revision } = await c0.one(sql`SELECT revision::text AS revision FROM account WHERE id=${a.id}`);
	const pending = ok(
		await c0.db.transaction((tx) =>
			deletion.requestAccountDeletion(
				tx,
				{ session: a.session, selected: { kind: "account", id: a.id } } as never,
				command({ confirmed: true }, revision) as never,
			),
		),
	);
	assert.equal(pending.status, "pending_deletion");
	const w = await c0.one(sql`SELECT id FROM lifecycle_witness WHERE kind='account' AND opaque_subject_id=${a.id}`);
	await graceEnds(w);
	assert.equal(await purge(), 1);
	assert.equal((await c0.one(sql`SELECT state FROM lifecycle_witness WHERE id=${w.id}`)).state, "purged");

	const r = s.records;
	assert.equal(await count(sql`SELECT count(*) AS n FROM person WHERE id=${r.contact} AND state='live'`), 1);
	assert.equal(await count(sql`SELECT count(*) AS n FROM training_credit WHERE id=${r.credit}`), 1);
	assert.equal(await count(sql`SELECT count(*) AS n FROM launch_milestone WHERE id=${r.milestone}`), 1);
	assert.equal((await c0.one(sql`SELECT creator_id FROM meeting WHERE id=${r.meeting}`)).creator_id, null);
	const removed = await c0.one(sql`SELECT u.name,u.email FROM auth_user u JOIN account x ON x.auth_user_id=u.id
		WHERE x.id=${a.id}`);
	assert.deepEqual(removed, { name: "Removed account", email: `removed-${a.id}@removed.invalid` });
	assert.equal(await count(sql`SELECT count(*) AS n FROM audit_event WHERE tenant_id=${p.id} AND actor_id=${a.id}`), 0);
	assert.ok(
		(await count(sql`SELECT count(*) AS n FROM audit_event WHERE tenant_id=${p.id} AND subject_id=${r.contact}
			AND actor_id IS NULL AND actor_token IS NOT NULL`)) > 0,
		"the Person's history stays with an opaque actor",
	);
	assert.equal(await count(sql`SELECT count(*) AS n FROM private_calendar WHERE author_id=${a.id}`), 0);
	assert.equal(await count(sql`SELECT count(*) AS n FROM private_week WHERE author_id=${a.id}`), 0);
	assert.equal(await count(sql`SELECT count(*) AS n FROM private_calendar WHERE author_id=${p.owner.id}`), 1);
	const words = await c0.rows(sql`SELECT 1 FROM private_week_revision WHERE note LIKE ${"%" + CANARY + "-alex%"}`);
	assert.equal(words.length, 0);

	assert.deepEqual(await current(p), before.p);
	assert.deepEqual(await network(s), before.network);
	assert.equal(
		await count(
			sql`SELECT count(*) AS n FROM lifecycle_witness WHERE kind='organization' OR opaque_subject_id=${s.s1.id}`,
		),
		0,
	);
	assert.equal(await count(sql`SELECT count(*) AS n FROM organization WHERE id=${s.s1.id}`), 1);
});

test("AC:SCHEMA-011 a workspace deletion request denies P at once, hides it from S1's current, history and location results and fences its pending job; a cancel with sharing current shows only what the live grant allows", async () => {
	const s = await portfolio("Request Fence");
	const { q } = s;
	let p = s.p;
	await share(s, p, "people", false);
	const later = randomUUID();
	ok(await requestIntelligenceRefresh(c0.db, s.director, { runId: later }));
	const before = {
		latest: await network(s),
		history: await network(s, "portfolio", s.runId),
		region: await network(s, "region"),
	};
	const shownBefore = rowsOf(before.latest).find((r) => r.plantId === p.id)!;
	assert.equal(shownBefore.status, "shared");
	const r0 = await current(p);
	ok(await assessments.submitFeedback(c0.db, p.actor, { runId: r0!.runId, ordinal: 1, rating: "useful", comment: "" }));
	const runsBefore = await count(sql`SELECT count(*) AS n FROM assessment_run WHERE plant_id=${p.id}`);
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));

	const pending = await requestDeletion(p);
	assert.equal(pending.status, "pending_deletion");
	assert.deepEqual(await RequestActor.resolve(c0.db, p.owner.session as never), { status: "unavailable" });
	assert.notEqual((await assessments.readAssessment(c0.db, p.actor, {})).status, "ok");
	for (const view of [await network(s), await network(s, "portfolio", s.runId), await network(s, "region")]) {
		assert.ok(view);
		assert.equal(JSON.stringify(view).includes(p.id), false, "no row, finding, health or concern of P");
		assert.equal(JSON.stringify(view).includes(r0!.runId), false);
		assert.deepEqual(
			rowsOf(view).map((r) => r.plantId),
			[q.id],
		);
	}
	await runAssessmentBatch(job, c0.db, scripted(), 20);
	assert.equal(await count(sql`SELECT count(*) AS n FROM assessment_run WHERE plant_id=${p.id}`), runsBefore);
	assert.deepEqual(
		await c0.rows(sql`SELECT state FROM job WHERE kind='assessment' AND subject_record_id=${p.id} AND state NOT IN
			('succeeded','superseded','failed')`),
		[{ state: "cancelled" }],
	);

	ok(await cancel(p, pending));
	p = await signIn(p);
	assert.deepEqual(await current(p), r0);
	assert.deepEqual(await network(s), before.latest);
	assert.deepEqual(await network(s, "portfolio", s.runId), before.history);
	assert.deepEqual(await network(s, "region"), before.region);
	const shown = rowsOf(await network(s)).find((r) => r.plantId === p.id)!;
	assert.ok(shown.status === "shared" && shown.assessment.status === "released");
	assert.equal(shown.assessment.runId, r0!.runId, "the current released result, not an older one");
});

test("AC:SCHEMA-011 AC:TEN-007 a cancel under a separately revoked grant revives no P result; a late cancel is refused; the purge removes P's assessments and every S1 run P fed, whole, and leaves Q, S1 and other accounts as they were; the witness clocks never move again", async () => {
	const s = await portfolio("Plant Purge");
	const { q, b } = s;
	let p = s.p;
	const fed = randomUUID();
	ok(await requestIntelligenceRefresh(c0.db, s.director, { runId: fed }));
	const r0 = await current(p);
	ok(await assessments.submitFeedback(c0.db, p.actor, { runId: r0!.runId, ordinal: 1, rating: "useful", comment: "" }));
	ok(
		await submitIntelligenceFeedback(c0.db, s.director, {
			runId: s.runId,
			patternKey: "portfolio:NIR-03",
			rating: "useful",
		}),
	);

	await share(s, p, "shared_findings", false);
	const first = await requestDeletion(p);
	const w1 = await witness(p);
	assert.deepEqual([w1.state, w1.request_id, w1.request_revision], ["pending_deletion", first.requestId, "1"]);
	const cancelled = ok(await cancel(p, first));
	const w2 = await witness(p);
	assert.deepEqual([w2.state, w2.request_id, w2.request_revision], ["cancelled", first.requestId, "1"]);
	assert.deepEqual([w2.requested_at, w2.cancel_until], [w1.requested_at, w1.cancel_until]);
	assert.equal(w2.cancelled_at.toISOString(), cancelled.cancelledAt);
	p = await signIn(p);
	assert.deepEqual(await current(p), r0, "P's normal access is back");
	for (const view of [await network(s), await network(s, "portfolio", s.runId), await network(s, "region")]) {
		const row = rowsOf(view).find((r) => r.plantId === p.id)!;
		assert.equal(row.status, "not_shared", "Limited visibility under the revoked grant");
		assert.equal(JSON.stringify(view).includes(r0!.runId), false);
	}
	const qOnly = randomUUID();
	ok(await requestIntelligenceRefresh(c0.db, s.director, { runId: qOnly }));

	const second = await requestDeletion(p);
	assert.notEqual(second.requestId, first.requestId);
	const w3 = await witness(p);
	assert.deepEqual(
		[w3.state, w3.request_id, w3.request_revision, w3.cancelled_at],
		["pending_deletion", second.requestId, "2", null],
	);
	assert.ok(w3.cancel_until > w1.cancel_until);
	await graceEnds(w3);
	const fenced = await witness(p);
	refused(await cancel(p, second), "deadline_passed");
	assert.deepEqual(await witness(p), fenced);

	const q0 = await current(q);
	const kept = async () => ({
		organization: await c0.one(sql`SELECT to_jsonb(o) AS row FROM organization o WHERE o.id=${s.s1.id}`),
		qOnly: await c0.rows(sql`SELECT to_jsonb(c) AS row FROM network_intelligence_plant c WHERE c.run_id=${qOnly}`),
		link: await c0.one(sql`SELECT to_jsonb(k) AS row FROM affiliation k WHERE k.id=${q.affiliation}`),
		account: await c0.one(sql`SELECT to_jsonb(x) AS row FROM account x WHERE x.id=${b.id}`),
		seats: await c0.rows(sql`SELECT to_jsonb(x) AS row FROM seat x WHERE x.account_id=${b.id} ORDER BY x.id`),
		qRuns: await c0.rows(sql`SELECT id,outcome FROM assessment_run WHERE plant_id=${q.id} ORDER BY id`),
	});
	const keptBefore = await kept();
	const fedRuns = [s.runId, fed];
	assert.equal(await count(sql`SELECT count(*) AS n FROM network_intelligence_feedback WHERE run_id=${s.runId}`), 1);

	assert.equal(await purge(), 1);
	const purged = await witness(p);
	assert.deepEqual(
		[purged.state, purged.request_id, purged.request_revision, purged.requested_at, purged.cancel_until],
		["purged", second.requestId, "2", fenced.requested_at, fenced.cancel_until],
	);
	assert.equal(purged.copy_expires_at.getTime() - purged.live_purged_at.getTime(), 7 * 86_400_000);
	for (const table of ["assessment_run", "assessment_insight", "assessment_feedback", "assessment_seen"])
		assert.equal(await count(sql`SELECT count(*) AS n FROM ${sql.raw(table)} WHERE plant_id=${p.id}`), 0, table);
	assert.equal(await count(sql`SELECT count(*) AS n FROM network_intelligence_plant WHERE plant_id=${p.id}`), 0);
	for (const run of fedRuns) {
		assert.equal(await count(sql`SELECT count(*) AS n FROM network_intelligence_run WHERE id=${run}`), 0);
		assert.equal(await count(sql`SELECT count(*) AS n FROM network_intelligence_plant WHERE run_id=${run}`), 0);
		assert.equal(await count(sql`SELECT count(*) AS n FROM network_intelligence_feedback WHERE run_id=${run}`), 0);
	}
	assert.deepEqual(await kept(), keptBefore);
	assert.deepEqual(await current(q), q0);
	assert.equal(
		await count(
			sql`SELECT count(*) AS n FROM lifecycle_witness WHERE kind='organization' OR opaque_subject_id=${s.s1.id}`,
		),
		0,
		"no organization deletion",
	);
	const after = randomUUID();
	ok(await requestIntelligenceRefresh(c0.db, s.director, { runId: after }));
	assert.deepEqual(await c0.rows(sql`SELECT plant_id FROM network_intelligence_plant WHERE run_id=${after}`), [
		{ plant_id: q.id },
	]);
	assert.deepEqual(
		rowsOf(await network(s)).map((r) => r.plantId),
		[q.id],
	);

	const refusedWrite = (set: ReturnType<typeof sql>) =>
		assert.rejects(c0.admin.execute(sql`UPDATE lifecycle_witness SET ${set} WHERE id=${purged.id}`), (e: any) =>
			/immutable_lifecycle_clock/.test(e.cause?.message ?? e.message),
		);
	await refusedWrite(
		sql`live_purged_at=live_purged_at+interval '1 day',copy_expires_at=copy_expires_at+interval '1 day'`,
	);
	await refusedWrite(sql`copy_expires_at=copy_expires_at+interval '1 hour'`);
	await refusedWrite(sql`request_id=gen_random_uuid(),live_purged_at=clock_timestamp(),
		copy_expires_at=clock_timestamp()+interval '7 days'`);
	await refusedWrite(sql`request_id=gen_random_uuid(),request_revision=request_revision+1,state='pending_deletion',
		cleanup_state='not_started',live_purged_at=NULL,copy_expires_at=NULL,requested_at=clock_timestamp(),
		cancel_until=clock_timestamp()+interval '30 days'`);
	assert.deepEqual(await witness(p), purged);
});

async function removal(s: Portfolio, requestKey: string = randomUUID()) {
	const owner = { kind: "plant" as const, id: s.p.id };
	const review = await seats.readRemoval(s.a.session, owner, { seatId: s.seatB.seatId });
	assert.deepEqual(
		review.duties.map((d) => d.dutyId),
		[s.seatB.task],
	);
	return command(
		{
			seatId: review.seatId,
			expectedRole: review.expectedRole,
			handoffs: review.duties.map((d) => ({
				kind: "needs_owner",
				dutyId: d.dutyId,
				expectedRevision: d.expectedRevision,
			})),
		},
		review.expectedRevision,
		requestKey,
	);
}
const removeSeat = (s: Portfolio, cmd: ReturnType<typeof command>) =>
	seats.remove(s.a.actor, { kind: "plant", id: s.p.id }, cmd, async () => {});
const eligible = async (s: Portfolio) =>
	(await c0.one(sql`SELECT ${eligibleOwner(sql`${s.seatB.id}::uuid`, sql`${s.p.id}::uuid`)} AS ok`)).ok as boolean;
const seatOf = (s: Portfolio) =>
	c0.one(sql`SELECT ended_at,revision::text AS revision FROM seat WHERE id=${s.seatB.seatId}`);
const leadAdmin = async (s: Portfolio) =>
	(
		await c0.one(sql`SELECT EXISTS(SELECT FROM person e JOIN seat x ON x.account_id=e.linked_account_id
			AND x.plant_id=e.plant_id AND x.role='admin' AND x.ended_at IS NULL
			WHERE e.id=${s.seatB.leader} AND e.state='live') AS ok`)
	).ok as boolean;

test("AC:MW-CASE-023 a fault in a required write of the seat removal returns required_write_failed and changes no seat, task, assessment input, network result or audit; the sweep finds nothing", async () => {
	const s = await portfolio("Removal Fault");
	const { p } = s;
	const before = {
		seat: await seatOf(s),
		facts: (await captureFacts(c0.db, p.id, null))!.sourceRevision,
		network: await network(s),
		assignees: await c0.rows(sql`SELECT account_id FROM task_assignee WHERE task_id=${s.seatB.task}`),
		audits: await count(sql`SELECT count(*) AS n FROM audit_event WHERE tenant_id=${p.id}`),
	};
	await job.scheduleAssessments(c0.db, 500);
	const demands = await changeDemands(p);
	await c0.admin.execute(
		sql.raw(`CREATE FUNCTION fail_removal() RETURNS trigger LANGUAGE plpgsql AS
		$$BEGIN RAISE EXCEPTION 'removal_audit_insert'; END$$`),
	);
	await c0.admin.execute(
		sql.raw(`CREATE TRIGGER fail_removal BEFORE INSERT ON audit_event FOR EACH ROW
		WHEN (NEW.action = 'membership.ended' AND NEW.subject_id = '${s.seatB.seatId}') EXECUTE FUNCTION fail_removal()`),
	);
	try {
		await assert.rejects(removeSeat(s, await removal(s)), (e: any) => e.value?.code === "required_write_failed");
	} finally {
		await c0.admin.execute(sql.raw(`DROP TRIGGER fail_removal ON audit_event; DROP FUNCTION fail_removal()`));
	}
	assert.deepEqual(await seatOf(s), before.seat);
	assert.equal(await eligible(s), true);
	assert.deepEqual(
		await c0.rows(sql`SELECT account_id FROM task_assignee WHERE task_id=${s.seatB.task}`),
		before.assignees,
	);
	assert.equal((await captureFacts(c0.db, p.id, null))!.sourceRevision, before.facts);
	assert.deepEqual(await network(s), before.network);
	assert.equal(await count(sql`SELECT count(*) AS n FROM audit_event WHERE tenant_id=${p.id}`), before.audits);
	await job.scheduleAssessments(c0.db, 500);
	assert.deepEqual(await changeDemands(p), demands, "no change demand for P");
});

test("AC:MW-CASE-023 Admin A removes Seat-B with no wakeup: R0 stays current, the next sweep queues one change demand whose run has a new source revision, S1's results are unchanged, and an exact replay adds nothing", async () => {
	const s = await portfolio("Removal Sweep");
	const { p } = s;
	const r0 = (await current(p))!;
	const r0Row = await c0.one(sql`SELECT source_revision FROM assessment_run WHERE id=${r0.runId}`);
	const s1 = await network(s);
	await job.scheduleAssessments(c0.db, 500);
	assert.deepEqual(await changeDemands(p), []);
	assert.deepEqual([await eligible(s), await leadAdmin(s)], [true, true]);

	const cmd = await removal(s);
	const removed = await removeSeat(s, cmd);
	assert.deepEqual(removed.duties, [{ status: "needs_owner", dutyId: s.seatB.task }]);
	assert.notEqual((await seatOf(s)).ended_at, null);
	assert.deepEqual([await eligible(s), await leadAdmin(s)], [false, false]);
	assert.deepEqual(await c0.rows(sql`SELECT account_id FROM task_assignee WHERE task_id=${s.seatB.task}`), []);
	assert.equal((await current(p))!.runId, r0.runId);
	const [event] = await c0.rows(sql`SELECT tenant_id,to_jsonb(e)::text AS body FROM audit_event e
		WHERE e.action='membership.ended' AND e.subject_id=${s.seatB.seatId}`);
	assert.equal(event!.tenant_id, p.id);
	assert.equal(event!.body.includes(CANARY), false);
	assert.equal(/strained|struggling/i.test(event!.body), false);

	clockMs = Date.now();
	await job.scheduleAssessments(c0.db, 500);
	const demands = await changeDemands(p);
	assert.equal(demands.length, 1);
	await runAssessmentBatch(job, c0.db, scripted(), 20);
	const run = await c0.one(sql`SELECT outcome,source_revision FROM assessment_run WHERE plant_id=${p.id}
		AND demand_key=${demands[0]!.producer_key}`);
	assert.equal(run.outcome, "published");
	assert.notEqual(run.source_revision, r0Row.source_revision);
	assert.deepEqual(await network(s), s1, "S1's results are unchanged");

	const jobs = await count(sql`SELECT count(*) AS n FROM job WHERE kind='assessment' AND subject_record_id=${p.id}`);
	const audits = await count(sql`SELECT count(*) AS n FROM audit_event WHERE tenant_id=${p.id}`);
	assert.deepEqual(await removeSeat(s, cmd), removed);
	assert.equal(await count(sql`SELECT count(*) AS n FROM audit_event WHERE tenant_id=${p.id}`), audits);
	await job.scheduleAssessments(c0.db, 500);
	assert.deepEqual(await changeDemands(p), demands);
	assert.equal(
		await count(sql`SELECT count(*) AS n FROM job WHERE kind='assessment' AND subject_record_id=${p.id}`),
		jobs,
	);
});

test("AC:MW-CASE-023 a run captured before P's input moved, and a run whose claim was taken over, settle superseded: R0 stays current and no notice is sent", async () => {
	const s = await portfolio("Stale Runs");
	const { p } = s;
	const r0 = (await current(p))!;
	const sent = await notices(p);
	const runs = () =>
		c0.rows(sql`SELECT id,outcome,reason,source_revision,demand_key FROM assessment_run WHERE plant_id=${p.id}
			ORDER BY captured_at,id`);

	let changed = false;
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await runAssessmentBatch(
		job,
		c0.db,
		scripted({
			during: async () => {
				if (changed) return;
				changed = true;
				await c0.committed(p, "Joined Mid-Draft", 0);
			},
		}),
		1,
	);
	const stale = (await runs()).at(-1)!;
	assert.deepEqual([stale.outcome, stale.reason], ["superseded", "changed_input"]);
	assert.notEqual(stale.source_revision, (await captureFacts(c0.db, p.id, null))!.sourceRevision);
	assert.equal((await current(p))!.runId, r0.runId);
	await c0.admin.execute(sql`UPDATE job SET state='cancelled',finished_at=clock_timestamp() WHERE kind='assessment'
		AND subject_record_id=${p.id} AND state='ready'`);

	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	let replaced = false;
	const second = scripted({ during: async () => void (await c0.committed(p, "Joined During Takeover", 0)) });
	const first = scripted({
		during: async () => {
			if (replaced) return;
			replaced = true;
			clockMs += ASSESSMENT_TIMING.leaseMs + 1000;
			assert.equal(await runAssessmentBatch(job, c0.db, second, 1), 1, "the expired claim is taken over");
		},
	});
	await runAssessmentBatch(job, c0.db, first, 1);
	clockMs = Date.now();
	const taken = (await runs()).at(-1)!;
	assert.notEqual(taken.id, stale.id);
	assert.deepEqual([taken.outcome, taken.reason], ["superseded", "changed_input"]);
	const claim = await c0.one(sql`SELECT claim_generation::int AS g FROM job WHERE kind='assessment'
		AND subject_record_id=${p.id} AND producer_key=${taken.demand_key}`);
	assert.equal(claim.g, 2, "the run settled under the newer claim");
	assert.equal(
		await count(sql`SELECT count(*) AS n FROM audit_event WHERE event_key=${"assessment:" + taken.id}`),
		1,
		"settled once, never published",
	);
	assert.equal((await current(p))!.runId, r0.runId);
	assert.equal(await notices(p), sent, "no notice");
});
