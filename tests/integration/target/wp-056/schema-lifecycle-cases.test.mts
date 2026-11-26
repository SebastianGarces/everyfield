import "../../platform/setup.mts";
import { openedDeletion } from "../../../support/deletion-cookie.mts";
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sessionId } from "../../../../packages/contracts/src/common/index.ts";
import type { Database } from "../../../../packages/db/src/client.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import {
	createAssessmentJob,
	createAssessments,
	runAssessmentBatch,
} from "../../../../packages/domain/src/intelligence/index.ts";
import { sharingOperations } from "../../../../packages/domain/src/organizations/sharing.ts";
import {
	readIntelligence,
	requestIntelligenceRefresh,
	submitIntelligenceFeedback,
} from "../../../../packages/domain/src/oversight/intelligence.ts";
import { deletionOperations } from "../../../../packages/domain/src/settings/index.ts";
import { issueRestrictedDeletionSession } from "../../../../packages/domain/src/settings/deletion.ts";
import { runDuePurges } from "../../../../packages/domain/src/jobs/lifecycle-purge.ts";
import { queueJobs } from "../../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { scriptedAssessmentDrafter } from "../../../../packages/evry-scripted/src/scripted-assessment.ts";
import { readCurrentManifest, restoreWithCurrentManifest } from "../../../../ops/maintenance/restore.mts";
import { ok, refused } from "../../../support/fixture.mts";
import { church, type Church } from "../../intelligence/assessment-church.mts";
import { dropTarget, freezeClock, objectStore, operator, snapshot, type Store } from "../sql/knowledge/support.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	expected: { result: Record<string, unknown>; event: null };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const c = cases.find((x) => x.id === "SCHEMA-011") ?? assert.fail("no SCHEMA-011");
const input = c.given["case-input"]!;
const DAY = 86_400_000;
const PURGE = new Date(String(input.live_purged_at));
const REQUEST = new Date(PURGE.getTime() - 30 * DAY);
const FIRST = new Date(REQUEST.getTime() - DAY);
const START = new Date(FIRST.getTime() - DAY);

let c0: Church;
const clock = { now: () => new Date().toISOString() as never };
const job = createAssessmentJob({ clock });
const assessments = createAssessments({ clock });
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
const targets: string[] = [];
async function at(when: Date) {
	await freezeClock(c0.admin, c0.database.schema, when);
	mock.timers.setTime(when.getTime());
}
before(async () => {
	mock.timers.enable({ apis: ["Date"], now: START.getTime() });
	c0 = await church("schema011", { cleanup: true, clock: START });
	await at(START);
	await c0.release("methodology-2026.11");
});
after(async () => {
	mock.timers.reset();
	for (const name of targets) await dropTarget(c0.admin, name);
	await c0?.database.close();
});

type Portfolio = Awaited<ReturnType<Church["portfolio"]>>;
type Plant = Portfolio["p"];
const command = (value: unknown, expectedRevision: string) => ({
	input: value,
	expectedRevision,
	requestKey: randomUUID(),
});
const count = async (q: SQL) => Number((await c0.one(q)).n);
async function publish(p: Plant) {
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));
	await runAssessmentBatch(job, c0.db, scriptedAssessmentDrafter({}), 20);
	const current = ok(await assessments.readAssessment(c0.db, p.actor, {})).current;
	assert.ok(current, "published");
	ok(await assessments.markAssessmentSeen(c0.db, p.actor, { runId: current.runId }));
	return current;
}
const witness = (p: { id: string }, where = c0.database.schema) =>
	c0.one(sql`SELECT state,request_id,request_revision::text AS revision,cancel_until,cancelled_at,live_purged_at,copy_expires_at
		FROM ${sql.raw(`${where}.lifecycle_witness`)} WHERE kind='plant' AND opaque_subject_id=${p.id}`);
async function requestDeletion(p: Plant) {
	const { revision } = await c0.one<{ revision: string }>(
		sql`SELECT revision::text AS revision FROM plant WHERE id=${p.id}`,
	);
	return ok(
		await gatedTransaction(c0.db, (tx) =>
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
	const handle = await openedDeletion(
		gatedTransaction(c0.db, (tx) =>
			issueRestrictedDeletionSession(tx, request as never, async () => ({
				accountId: p.owner.id,
				provenAt: new Date(Date.now() - 1000),
			})),
		),
		request,
	);
	return gatedTransaction(c0.db, (tx) =>
		deletion.cancelWorkspaceDeletion(tx, handle, command(request, pending.revision) as never),
	);
}
async function signIn(p: Plant): Promise<Plant> {
	const session = sessionId.parse(randomUUID());
	await c0.admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
		VALUES(${session},${p.owner.user},${randomBytes(32).toString("hex")},clock_timestamp()+interval '60 days')`);
	const actor = (await RequestActor.resolve(c0.db, session)) as RequestActor;
	return { ...p, owner: { ...p.owner, session }, actor, ctx: { ...p.ctx, session } };
}
async function revoke(s: Portfolio, p: Plant) {
	const a = await c0.one<{ revision: string; consent: string }>(
		sql`SELECT revision::text AS revision,consent_revision::text AS consent FROM affiliation WHERE id=${p.affiliation}`,
	);
	const shared = await gatedTransaction(c0.db, (tx) =>
		sharing["privacy.setSharing"](
			tx,
			p.owner.session as never,
			{ kind: "plant", id: p.id } as never,
			command(
				{
					plant: { kind: "plant", id: p.id },
					organization: { kind: "organization", id: s.s1.id, organizationKind: "sending_network" },
					relationshipId: p.affiliation,
					expectedConsentRevision: a.consent,
					category: "shared_findings",
					enabled: false,
				},
				a.revision,
			) as never,
		),
	);
	assert.deepEqual(shared, { status: "committed" });
}
const footprint = (id: string, where = c0.database.schema) => {
	const t = (name: string) => sql.raw(`${where}.${name}`);
	return c0.one(sql`SELECT
		(SELECT count(*)::int FROM ${t("assessment_run")} WHERE plant_id=${id}) AS facts,
		(SELECT count(*)::int FROM ${t("assessment_insight")} WHERE plant_id=${id}) AS findings,
		(SELECT count(*)::int FROM ${t("network_intelligence_plant")} WHERE plant_id=${id}) AS contributors,
		(SELECT count(*)::int FROM ${t("assessment_feedback")} WHERE plant_id=${id})
			+(SELECT count(*)::int FROM ${t("network_intelligence_feedback")} f WHERE EXISTS(SELECT FROM ${t("network_intelligence_plant")} x
				WHERE x.run_id=f.run_id AND x.plant_id=${id})) AS feedback,
		(SELECT count(*)::int FROM ${t("plant")} WHERE id=${id} AND name<>'Removed workspace') AS plant`);
};

test("AC:SCHEMA-011 a purge removes P's assessments, findings, contributions and linked feedback at the pinned instant, leaves Q and S1, never resets the copy expiry, and a restored older copy brings none of P back", async () => {
	const s = await portfolio();
	const { q } = s;
	let p = s.p;
	const fed = s.runId;
	const r0 = ok(await assessments.readAssessment(c0.db, p.actor, {})).current!;
	ok(await assessments.submitFeedback(c0.db, p.actor, { runId: r0.runId, ordinal: 1, rating: "useful", comment: "" }));
	const view = await readIntelligence(c0.db, s.director, { level: "portfolio", runId: fed });
	const [pattern] = view!.groups.flatMap((g) => g.patterns);
	assert.ok(pattern, JSON.stringify(view));
	ok(await submitIntelligenceFeedback(c0.db, s.director, { runId: fed, patternKey: pattern!.key, rating: "useful" }));
	const live = await footprint(p.id);
	assert.ok(
		Object.values(live).every((n) => Number(n) > 0),
		JSON.stringify(live),
	);
	await c0.admin.execute(sql`UPDATE auth_session SET expires_at=${new Date(PURGE.getTime() + 30 * DAY).toISOString()}`);
	const store: Store = new Map();
	const copies = [await snapshot(c0.admin, store, { createdAt: FIRST })];

	await revoke(s, p);
	await at(FIRST);
	const first = await requestDeletion(p);
	copies.push(await snapshot(c0.admin, store, { createdAt: FIRST }));
	await at(new Date(FIRST.getTime() + 3_600_000));
	assert.equal(ok(await cancel(p, first)).status, "cancelled");
	p = await signIn(p);
	const shown = (await readIntelligence(c0.db, s.director, { level: "portfolio", runId: null }))!.groups
		.flatMap((g) => g.rows)
		.find((r) => r.plantId === p.id)!;
	assert.equal(shown.status, "not_shared", "the cancel keeps the separately revoked grant");
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: randomUUID() }));

	await at(REQUEST);
	const second = await requestDeletion(p);
	const pending = await witness(p);
	assert.deepEqual(
		[pending.state, pending.revision, new Date(String(pending.cancel_until)).toISOString(), pending.cancelled_at],
		["pending_deletion", "2", PURGE.toISOString(), null],
	);
	assert.equal(
		(
			await c0.one(sql`SELECT count(*)::int AS n FROM job WHERE kind='assessment' AND subject_record_id=${p.id}
			AND state IN ('ready','claimed','retry_wait')`)
		).n,
		0,
		"the pending job is fenced",
	);
	const beforePurge = new Date(PURGE.getTime() - 3_600_000);
	await at(beforePurge);
	copies.push(await snapshot(c0.admin, store, { createdAt: beforePurge }));

	await at(PURGE);
	refused(await cancel(p, second), "deadline_passed");
	const qOnly = randomUUID();
	ok(await requestIntelligenceRefresh(c0.db, s.director, { runId: qOnly }));
	assert.deepEqual(await c0.rows(sql`SELECT plant_id FROM network_intelligence_plant WHERE run_id=${qOnly}`), [
		{ plant_id: q.id },
	]);
	const kept = async () => ({
		q: await c0.one(sql`SELECT (SELECT count(*)::int FROM assessment_run WHERE plant_id=${q.id}) AS facts,
			(SELECT count(*)::int FROM assessment_insight WHERE plant_id=${q.id}) AS findings,
			(SELECT json_agg(to_jsonb(x) ORDER BY x.plant_id) FROM network_intelligence_plant x WHERE x.run_id=${qOnly}) AS contributors`),
		org: await c0.one(sql`SELECT to_jsonb(o) AS row FROM organization o WHERE o.id=${s.s1.id}`),
		qAccount: await c0.one(sql`SELECT to_jsonb(x) AS row FROM account x WHERE x.id=${s.b.id}`),
	});
	const keptBefore = await kept();
	const cleanup = (c0.database.pools as Record<string, Database>).cleanup!;
	const storage = { bucket: "synthetic-only", client: { send: async () => ({}) } };
	assert.equal(await runDuePurges(c0.db, cleanup, storage as never, 10), 1);
	const purged = await witness(p);
	const iso = (v: unknown) => new Date(String(v)).toISOString().replace(".000Z", "Z");
	assert.deepEqual(
		[purged.state, purged.request_id, purged.revision, iso(purged.live_purged_at)],
		["purged", second.requestId, "2", String(input.live_purged_at)],
	);
	await assert.rejects(
		c0.admin.execute(sql`UPDATE lifecycle_witness SET copy_expires_at=copy_expires_at+interval '1 day'
			WHERE kind='plant' AND opaque_subject_id=${p.id}`),
		(e: Error) => /immutable_lifecycle_clock/.test(String(e.cause ?? e)),
	);
	await assert.rejects(
		c0.admin.execute(sql`UPDATE lifecycle_witness SET live_purged_at=clock_timestamp()+interval '1 hour'
			WHERE kind='plant' AND opaque_subject_id=${p.id}`),
		(e: Error) => /immutable_lifecycle_clock/.test(String(e.cause ?? e)),
	);

	await at(new Date(PURGE.getTime() + 3_600_000));
	const restores = [];
	for (const copy of copies) {
		const target = `${c0.database.schema.slice(0, 50)}_r${targets.length}`;
		targets.push(target);
		const reply = await restoreWithCurrentManifest(
			{
				admin: c0.admin,
				source: c0.database.schema,
				targetSchema: target,
				objects: objectStore(new Map()),
				clock: () => new Date(),
			},
			{ capability: operator, target: "isolated", snapshot: copy, current: () => readCurrentManifest(c0.admin) },
		);
		restores.push(reply);
		if (reply.restore_success) {
			assert.deepEqual(await footprint(p.id, target), {
				facts: 0,
				findings: 0,
				contributors: 0,
				feedback: 0,
				plant: 0,
			});
			const back = await witness(p, target);
			assert.deepEqual([back.state, iso(back.copy_expires_at)], ["purged", iso(purged.copy_expires_at)]);
			assert.equal((await footprint(q.id, target)).plant, 1);
		}
	}
	assert.deepEqual(
		restores.map((r) => (r.restore_success ? true : r.refusal)),
		["copy_expired_or_invalid", "copy_expired_or_invalid", true],
		"the copies from before the request and from between request and cancel are past their seven days",
	);
	const after = await witness(p);
	const gone = await footprint(p.id);
	const network = JSON.stringify(await readIntelligence(c0.db, s.director, { level: "portfolio", runId: null }));
	const checks = String(
		(
			await c0.one(sql`SELECT string_agg(pg_get_constraintdef(oid),' ') AS d FROM pg_constraint
				WHERE conrelid='lifecycle_witness'::regclass AND contype='c'`)
		).d,
	);
	assert.deepEqual(await kept(), keptBefore);
	assert.deepEqual(
		{
			P_normal_access: (await RequestActor.resolve(c0.db, p.owner.session as never)) instanceof RequestActor,
			P_copied_org_assessment_body:
				(await count(sql`SELECT count(*) AS n FROM network_intelligence_run WHERE id=${fed}`)) +
					(network.includes(p.id) ? 1 : 0) >
				0
					? network
					: null,
			P_assessment_fact_rows: gone.facts,
			P_finding_rows: gone.findings,
			P_assessment_contributor_rows: gone.contributors,
			P_linked_reader_feedback_rows: gone.feedback,
			Q_survives: (await footprint(q.id)).plant === 1 && Number((await footprint(q.id)).facts) > 0,
			org_survives: (await count(sql`SELECT count(*) AS n FROM organization WHERE id=${s.s1.id}`)) === 1,
			copy_expires_at: iso(after.copy_expires_at),
			expiry_reset: iso(after.copy_expires_at) !== iso(purged.copy_expires_at),
			public_org_delete_registered:
				(await count(sql`SELECT count(*) AS n FROM lifecycle_witness WHERE kind NOT IN ('account','plant')
					OR opaque_subject_id=${s.s1.id}`)) > 0 ||
				!/kind = ANY \(ARRAY\['account'::text, 'plant'::text\]\)/.test(checks) ||
				Object.keys(deletion).some((name) => /organization|network/i.test(name)),
		},
		c.expected.result,
	);
	assert.equal(c.expected.event, null);
});

async function portfolio() {
	return c0.portfolio("Schema Purge", publish);
}
