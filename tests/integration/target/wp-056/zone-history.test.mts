import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { frozenClock, instant, owner } from "../../../../packages/contracts/src/common/index.ts";
import { sql } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import {
	createAssessmentJob,
	createAssessments,
	runAssessmentBatch,
} from "../../../../packages/domain/src/intelligence/index.ts";
import { enqueueJob } from "../../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { timezoneOperations } from "../../../../packages/domain/src/settings/index.ts";
import { scriptedAssessmentDrafter } from "../../../../packages/evry-scripted/src/scripted-assessment.ts";
import { ok, refused } from "../../../support/fixture.mts";
import { church, type Church } from "../../intelligence/assessment-church.mts";

const AS_OF = instant.parse("2026-10-01T16:00:00Z");
const EDIT_AT = instant.parse("2026-10-13T16:00:00Z");
let c: Church;
before(async () => {
	c = await church("zone_history", { clock: new Date("2026-10-01T15:55:00Z") });
	await c.release("r1");
});
after(() => c?.database.close());

test("AC:B03-014 a church zone change rewrites no past meeting, history row or earlier assessment, whose as-of and church day stay as recorded", async () => {
	const p = await c.plant("Harbor Plant");
	const admin = await c.database.actor(p, "admin");
	const member = await c.database.actor(p, "member");
	const resolve = async (session: string) => {
		const found = await RequestActor.resolve(c.db, session as never);
		assert.ok(found instanceof RequestActor);
		return found;
	};
	const reader = await resolve(admin.session);
	const adults = [await c.committed(p, "Ana Ruiz"), await c.committed(p, "Ben Cole")];
	const meeting = await c.vision(p, 3, adults);
	const clock = frozenClock(AS_OF);
	const assessments = createAssessments({ clock });
	ok(await assessments.requestRefresh(c.db, p.actor, { requestId: randomUUID() }));
	await runAssessmentBatch(createAssessmentJob({ clock }), c.db, scriptedAssessmentDrafter(), 5);

	const read = async () => ok(await assessments.readAssessment(c.db, reader, {})).current!;
	const stored = async () => ({
		runs: await c.rows(sql`SELECT to_jsonb(r) AS row FROM assessment_run r WHERE plant_id=${p.id} ORDER BY id`),
		insights: await c.rows(
			sql`SELECT to_jsonb(i) AS row FROM assessment_insight i WHERE plant_id=${p.id} ORDER BY run_id,ordinal`,
		),
		meetings: await c.rows(sql`SELECT to_jsonb(m) AS row FROM meeting m WHERE plant_id=${p.id}`),
		attendance: await c.rows(sql`SELECT to_jsonb(x) AS row FROM participation x WHERE plant_id=${p.id} ORDER BY id`),
		commitments: await c.rows(sql`SELECT to_jsonb(x) AS row FROM commitment x WHERE plant_id=${p.id} ORDER BY id`),
	});
	const audits = () =>
		c.rows<{ id: string }>(sql`SELECT to_jsonb(a) AS row,id FROM audit_event a WHERE tenant_id=${p.id} ORDER BY id`);
	const start = { view: await read(), stored: await stored(), audits: await audits() };
	assert.equal(start.view.asOf, "2026-10-01T16:00:00.000Z");
	assert.equal(start.view.measuredOn, "2026-10-01", "the Chicago day; Auckland is already on the 2nd");
	const past = await c.one(
		sql`SELECT timezone,starts_at<${AS_OF}::timestamptz AS past,local_date::text FROM meeting WHERE id=${meeting}`,
	);
	assert.deepEqual(past, { timezone: "America/Chicago", past: true, local_date: "2026-09-28" });

	const selected = owner.parse({ kind: "plant", id: p.id });
	assert.ok(selected.kind === "plant");
	const zones = timezoneOperations(
		{
			replan: (tx, i) =>
				enqueueJob(tx, {
					tenant: i.owner.id,
					kind: "digest",
					subject: i.owner.id,
					key: `settings/${i.kind}/${i.operationId}`,
					revision: i.revision,
					eligibleAt: EDIT_AT,
				}),
		},
		undefined,
		frozenClock(EDIT_AT),
	);
	const as = (who: { session: string }) => ({ session: who.session as never, selected });
	const preview = ok(
		await gatedTransaction(c.db, (tx) =>
			zones.previewPlantTimezone(tx, as(admin), { plant: selected, timeZone: "Pacific/Auckland" }),
		),
	);
	const set = (who: { session: string }, expectedRevision: string, requestKey: string) =>
		gatedTransaction(c.db, (tx) =>
			zones.setPlantTimezone(tx, as(who), {
				requestKey,
				expectedRevision,
				input: { plant: selected, timeZone: "Pacific/Auckland", previewId: preview.previewId },
			}),
		);
	refused(await set(member, preview.expectedRevision, randomUUID()));
	refused(await set(admin, "999", randomUUID()), "conflict");
	assert.deepEqual(await audits(), start.audits);
	const key = randomUUID();
	const changed = ok(await set(admin, preview.expectedRevision, key));
	assert.equal(changed.status, "changed");
	assert.deepEqual(ok(await set(admin, preview.expectedRevision, key)), changed);
	assert.deepEqual(await c.one(sql`SELECT timezone FROM plant WHERE id=${p.id}`), { timezone: "Pacific/Auckland" });

	assert.deepEqual(await stored(), start.stored);
	const view = await read();
	assert.deepEqual(
		[view.runId, view.asOf, view.measuredOn, view.summary],
		[start.view.runId, "2026-10-01T16:00:00.000Z", "2026-10-01", start.view.summary],
	);
	const ids = new Set(start.audits.map((a) => a.id));
	const now = await audits();
	assert.deepEqual(
		now.filter((a) => ids.has(a.id)),
		start.audits,
	);
	assert.equal(now.length, start.audits.length + 1, "one zone event and no rewritten history");
});
