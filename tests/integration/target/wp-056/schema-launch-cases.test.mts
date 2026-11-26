import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { frozenClock, instant } from "../../../../packages/contracts/src/common/index.ts";
import type { DebriefAnswers, Plan } from "../../../../packages/contracts/src/launch/index.ts";
import {
	authorizeLaunchNotices,
	createLaunchReader,
	createLaunchWriter,
} from "../../../../packages/domain/src/launch/index.ts";
import { PeopleReadContext, withPeopleWrite } from "../../../../packages/domain/src/people/core.ts";
import { peopleMerge } from "../../../../packages/domain/src/people/index.ts";
import { createMailService } from "../../../../packages/domain/src/jobs/mail.ts";
import { seatedNotificationService } from "../../../../packages/domain/src/jobs/seated-notifications.ts";
import { launchNotices } from "../../../../apps/web/src/features/launch/notices.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { fixture } from "../../identity/invitations-support.mts";
import { ok } from "../../../support/fixture.mts";
import { accepts, schemaCase } from "./schema-probe.mts";

const c = schemaCase("SCHEMA-005");
const NOW = new Date(String(c.clock?.now));
let f: Awaited<ReturnType<typeof fixture>>;
let reader: ReturnType<typeof createLaunchReader>;
let writer: ReturnType<typeof createLaunchWriter>;
before(async () => {
	f = await fixture({ clock: NOW });
	const mail = createMailService({
		db: f.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "launch@example.test",
		authorize: authorizeLaunchNotices,
		transport: {
			async send() {
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	const clock = frozenClock(instant.parse(NOW.toISOString()));
	reader = createLaunchReader(clock);
	writer = createLaunchWriter({ notices: launchNotices(seatedNotificationService(mail)), clock });
});
after(() => f?.close());

const key = () => randomUUID();
const one = async (q: SQL) => (await f.admin.execute<Record<string, unknown>>(q)).rows[0]!;
const BLANK = {
	wentWell: null,
	toChange: null,
	operations: null,
	followUpPlan: null,
	supportNeeded: null,
	missingNames: null,
	missingCount: null,
};

async function person(plant: string, name: string) {
	const id = randomUUID();
	await f.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${plant},${plant},${name},'other','prospect','unknown','unknown','1','live',clock_timestamp())`);
	return id;
}

test("AC:SCHEMA-005 one Launch keeps one aggregate count and one link per named Person, and its debrief evidence is the submitted version", async () => {
	const L = c.given.L!;
	const w = await f.workspace("plant", { name: "Harvest Point", timezone: "America/Chicago" });
	const owner = await f.account();
	await f.seat(owner, w, "owner");
	const actor = await f.actor(owner.session);
	const other = await f.workspace("plant", { timezone: "America/New_York" });
	const plan = async () => ok(await reader.readPlan(f.db, actor)).plan;
	const named = (p: Plan) => p.guests.named!.map((g) => g.displayName);
	const debrief = async (answers: Partial<DebriefAnswers>, submit: boolean) => {
		const p = await plan();
		return ok(
			await writer[submit ? "submitDebrief" : "saveDebriefDraft"](f.db, actor, {
				requestKey: key(),
				expectedRevision: p.debrief!.draft?.revision ?? "0",
				input: { draftId: p.debrief!.draft?.id ?? null, answers: { ...BLANK, ...answers } },
			}),
		).plan;
	};
	const counts = () =>
		one(sql`SELECT (SELECT count(*)::int FROM meeting WHERE plant_id=${w.id}) meetings,
			(SELECT count(*)::int FROM task WHERE plant_id=${w.id}) tasks`);

	ok(
		await writer.schedule(f.db, actor, {
			requestKey: key(),
			expectedRevision: "1",
			input: { date: "2026-10-11", reason: null },
		}),
	);
	const before = await counts();
	ok(
		await writer.recordOutcome(f.db, actor, {
			requestKey: key(),
			expectedRevision: (await plan()).revision,
			input: { actualDate: "2026-10-11", attendance: L.actual_attendance, decisions: null, note: null },
		}),
	);
	const guestName = String(c.action.arguments.duplicate_named_guest);
	const linked = ok(
		await writer.addGuestAttendance(f.db, actor, { requestKey: key(), input: { displayName: guestName } }),
	);
	const alex = linked.plan.guests.named![0]!.personId;
	const again = ok(await writer.addGuestAttendance(f.db, actor, { requestKey: key(), input: { personId: alex } }));
	const link = (personId: string, plant = w.id) =>
		sql`INSERT INTO launch_guest(plant_id,person_id) VALUES(${plant},${personId})`;
	const duplicateRow = await accepts(f.admin, link(alex));
	assert.equal(await accepts(f.admin, link(await person(w.id, "Casey"))), true, "a same-church Person links");
	assert.equal(
		await accepts(f.admin, link(await person(other.id, "Quinn"))),
		false,
		"another church's Person is refused",
	);
	assert.equal(await accepts(f.admin, link(alex, other.id)), false, "another church's Launch is refused");

	const namesake = await person(w.id, guestName);
	ok(await writer.addGuestAttendance(f.db, actor, { requestKey: key(), input: { personId: namesake } }));
	const review = ok(
		await gatedTransaction(f.db, (t) =>
			peopleMerge.getMergeReview(t, new PeopleReadContext(actor), { sourceId: namesake, survivorId: alex }),
		),
	);
	ok(
		await withPeopleWrite(f.db, actor, (t, ctx) =>
			peopleMerge.mergePeople(t, ctx, {
				requestKey: key(),
				input: { sourceId: namesake, survivorId: alex, reviewDigest: review.reviewDigest, fieldChoices: {} },
			}),
		),
	);

	const submitted = await debrief({ wentWell: "Worship", missingNames: "no" }, true);
	const first = submitted.debrief!.submitted!;
	const states = new Map([[JSON.stringify(first), String(L.submitted_debrief_state)]]);
	assert.equal(c.action.arguments.new_incomplete_draft, true);
	const drafted = await debrief({ wentWell: "Half written" }, false);
	assert.equal(drafted.debrief!.draft!.submittedAt, null);
	states.set(JSON.stringify(drafted.debrief!.draft), String(L.draft_state));
	const evidence = drafted.debrief!.submitted!;
	assert.deepEqual(drafted.evidence.debriefDone, { status: "met" });

	const summaryPlan = await plan();
	const draftSummary = ok(
		await writer.saveDebriefSummaryDraft(f.db, actor, {
			requestKey: key(),
			expectedRevision: summaryPlan.summary!.draft?.revision ?? "0",
			input: { draftId: null, body: "Service held." },
		}),
	).plan;
	ok(
		await writer.publishDebriefSummary(f.db, actor, {
			requestKey: key(),
			expectedRevision: draftSummary.summary!.draft!.revision,
			input: { draftId: draftSummary.summary!.draft!.id, body: "Service held." },
		}),
	);
	const corrected = await debrief({ wentWell: "Worship and kids", missingNames: "no" }, true);
	assert.equal(corrected.debrief!.submitted!.version, first.version + 1);
	assert.deepEqual(
		(await f.admin.execute(sql`SELECT version FROM launch_debrief WHERE plant_id=${w.id} ORDER BY version`)).rows,
		[{ version: 1 }, { version: 2 }],
	);

	const last = await plan();
	const after = await counts();
	assert.equal(last.guests.count, 1);
	assert.ok(last.outcome!.attendance! > last.guests.count);
	assert.deepEqual(
		{
			named_guests: named(last),
			attendance: last.outcome!.attendance,
			evidence_debrief_state: states.get(JSON.stringify(evidence)) ?? JSON.stringify(evidence),
			duplicate_link_accepted: again.outcome !== "noop" || duplicateRow,
			meetings_added: Number(after.meetings) - Number(before.meetings),
			follow_up_tasks_added: Number(after.tasks) - Number(before.tasks),
		},
		c.expected.result,
	);
	assert.equal(last.summary!.published.length, 1);
});
