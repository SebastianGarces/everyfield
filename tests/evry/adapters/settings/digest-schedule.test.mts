// T-342: an Owner or Admin changes the church-wide planter digest schedule through Evry (church.digestSchedule.set),
// only by approving an exact review, and the change runs the same native Settings command the Church section runs. The
// church is Hope Fellowship (golden-church.mts, America/Chicago, weekly on Sundays at 4 PM); every effect runs through
// the real queue with the native services the Settings screens use (settings-ports.mts).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import { withSettingsWrite } from "../../../../packages/domain/src/settings/index.ts";
import {
	approveProposal,
	createConversation,
	executeProposal,
	invokeRead,
	prepareProposal,
	readCatalog,
	readReview,
	submitTurn,
	type EvryActor,
	type Proposal,
} from "../../../../packages/evry/src/index.ts";
import { CHURCH_COMMANDS } from "../../../../packages/evry/src/adapters/settings/commands/index.ts";
import { NOTIFICATION_READS } from "../../../../packages/evry/src/adapters/notifications/reads/index.ts";
import { transaction } from "../../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../../apps/web/src/server/jobs/queue.ts";
import { goldenChurch, PLANT, type GoldenChurch } from "../../evals/golden-church.mts";
import { nativePorts } from "../../evals/settings-ports.mts";

const OPERATION = "church.digestSchedule.set";
const native = nativePorts();
const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};
let church: GoldenChurch;

before(async () => {
	church = await goldenChurch({ seatNames: true });
});
after(() => church?.close());

/** A held turn in a fresh conversation, and the propose_change call the model would make in it. */
async function turn(who: EvryActor) {
	const db = church.db;
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const lease = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	return async (schedule: unknown) => {
		const proposal = await prepareProposal(
			db,
			who,
			lease,
			c.id,
			{ operation: OPERATION, input: { schedule } },
			null,
			native,
		);
		assert.ok(proposal, "a review is prepared");
		return proposal;
	};
}
async function runNext() {
	const [claim] = await claimDue(church.db, ["evry_effect"], 1, 60);
	if (!claim) return null;
	const outcome = await executeProposal(
		church.db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		noReminders,
		null,
		native,
	);
	await transaction(church.db, (tx) =>
		finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }),
	);
	return outcome;
}
async function approve(who: EvryActor, proposal: Proposal) {
	const approved = await approveProposal(
		church.db,
		who,
		proposal.id,
		{ revision: proposal.revision, digest: proposal.digest },
		null,
	);
	return { approved, outcome: await runNext(), review: await readReview(church.db, who, proposal.id) };
}
/** The schedule Settings > Church shows, from the plant row it reads. */
const schedule = async () =>
	(
		await church.admin.execute(
			sql`SELECT digest_cadence AS cadence,digest_weekday AS weekday,digest_hour AS hour,revision::int AS revision FROM plant WHERE id=${PLANT}`,
		)
	).rows[0];
const churchAudits = async () =>
	(
		await church.admin.execute(
			sql`SELECT action,metadata FROM audit_event WHERE tenant_id=${PLANT} AND kind='preference' ORDER BY occurred_at`,
		)
	).rows;
const NOTES = [
	"Times are in Central time (America/Chicago), the church's time zone.",
	"This changes the church digest for everyone who gets it.",
];

test("INV-church-digest-schedule the tool takes only the native digestSchedule shape", () => {
	const input = CHURCH_COMMANDS[OPERATION].input;
	for (const ok of [{ cadence: "off" }, { cadence: "daily", hour: 7 }, { cadence: "weekly", weekday: 1, hour: 8 }])
		assert.equal(input.safeParse({ schedule: ok }).success, true, JSON.stringify(ok));
	for (const bad of [
		{ cadence: "hourly" },
		{ cadence: "every_3_hours" },
		{ cadence: "weekly", weekday: 0, hour: 16.5 },
		{ cadence: "weekly", weekday: 0, hour: 16, minute: 30 },
		{ cadence: "weekly", weekdays: [0, 3], hour: 16 },
		{ cadence: "weekly", weekday: 7, hour: 8 },
		{ cadence: "daily", hour: 24 },
		{ cadence: "daily" },
		{ cadence: "off", hour: 8 },
	])
		assert.equal(input.safeParse({ schedule: bad }).success, false, JSON.stringify(bad));
	assert.equal(
		input.safeParse({ schedule: { cadence: "off" }, plant: PLANT }).success,
		false,
		"no input names a church",
	);
});

test("INV-church-digest-schedule only a church Owner or Admin is offered it; a Member, an organization and an empty-seat context are not", () => {
	const offered = (who: keyof GoldenChurch["actors"]) =>
		readCatalog(church.actors[who]).reviewedWrites.some((w) => w.operation === OPERATION);
	assert.equal(offered("owner"), true);
	assert.equal(offered("admin"), true);
	assert.equal(offered("member"), false);
	assert.equal(offered("network"), false);
	assert.equal(offered("org"), false);
});

test("INV-church-digest-schedule the Owner's Monday 8 AM review changes nothing until approved, then saves as Settings does, once", async () => {
	const owner = church.actors.owner;
	const propose = await turn(owner);
	await assert.rejects(propose({ cadence: "hourly" }), /invalid_input/);
	const start = await schedule();
	assert.deepEqual({ ...start, revision: undefined }, { cadence: "weekly", weekday: 0, hour: 16, revision: undefined });
	const proposal = await propose({ cadence: "weekly", weekday: 1, hour: 8 });
	assert.equal(proposal.status, "pending");
	assert.deepEqual(proposal.review.target, { kind: "church", id: PLANT, label: "Hope Fellowship" });
	assert.deepEqual(proposal.review.changes, [
		{ field: "digestSchedule", before: "Weekly on Sundays at 4:00 PM", after: "Weekly on Mondays at 8:00 AM" },
	]);
	assert.deepEqual(proposal.review.notes, NOTES);
	assert.equal(proposal.review.refusal, undefined);
	// Only a card so far: Settings > Church still shows Sunday at 4 PM.
	assert.deepEqual(await schedule(), start);
	const audits = (await churchAudits()).length;

	const first = await approve(owner, proposal);
	assert.equal(first.outcome, "completed");
	assert.equal(first.review.outcome, "completed");
	assert.deepEqual(await schedule(), { cadence: "weekly", weekday: 1, hour: 8, revision: Number(start!.revision) + 1 });
	// The same audit row the Church section's own save writes (D-1376).
	const written = await churchAudits();
	assert.equal(written.length, audits + 1);
	assert.deepEqual(written.at(-1), {
		action: "plant.profile_changed",
		metadata: { section: "plant", diff: { digest: true } },
	});

	// Approving the same card again shows it as already applied and writes nothing.
	const again = await approve(owner, proposal);
	assert.equal(again.approved.replayed, true);
	assert.equal(again.outcome, null, "no second effect is queued");
	assert.equal(again.review.outcome, "completed");
	assert.equal((await churchAudits()).length, audits + 1);
	assert.equal((await schedule())!.revision, Number(start!.revision) + 1);

	// The next digest the Owner asks about goes out on the new day and hour.
	const planterDigest = NOTIFICATION_READS.find((r) => r.operation === "notifications.previewPlanterDigest")!;
	const next = await invokeRead(church.db, owner, planterDigest as never, {});
	assert.match(String(next.rows[0]?.fields.sendsAt), /^Mon, [A-Z][a-z]{2} \d{1,2}, 8:00\sAM$/);
});

test("INV-church-digest-schedule the Admin's review to daily at 7 AM saves what it shows", async () => {
	const admin = church.actors.admin;
	const proposal = await (await turn(admin))({ cadence: "daily", hour: 7 });
	assert.deepEqual(proposal.review.changes, [
		{ field: "digestSchedule", before: "Weekly on Mondays at 8:00 AM", after: "Daily at 7:00 AM" },
	]);
	assert.deepEqual(proposal.review.notes, NOTES);
	assert.equal((await approve(admin, proposal)).outcome, "completed");
	assert.deepEqual(
		{ ...(await schedule()), revision: undefined },
		{ cadence: "daily", weekday: 1, hour: 7, revision: undefined },
	);
});

test("INV-church-digest-schedule turning it off saves Off; asking for the schedule it already has can't be approved and writes nothing", async () => {
	const owner = church.actors.owner;
	const off = await (await turn(owner))({ cadence: "off" });
	assert.deepEqual(off.review.changes, [{ field: "digestSchedule", before: "Daily at 7:00 AM", after: "Off" }]);
	assert.equal((await approve(owner, off)).outcome, "completed");
	assert.equal((await schedule())!.cadence, "off");

	const before = await schedule();
	const audits = (await churchAudits()).length;
	const same = await (await turn(owner))({ cadence: "off" });
	assert.deepEqual(same.review.changes, [{ field: "digestSchedule", before: "Off", after: "Off" }]);
	assert.equal(same.review.refusal, "The church digest already goes out on this schedule, so nothing would change.");
	await assert.rejects(
		approveProposal(church.db, owner, same.id, { revision: same.revision, digest: same.digest }, null),
	);
	assert.equal(await runNext(), null, "nothing is queued");
	assert.deepEqual(await schedule(), before);
	assert.equal((await churchAudits()).length, audits);
});

test("INV-church-digest-schedule a church settings change in Settings after the review makes approval stale, and nothing is saved", async () => {
	const owner = church.actors.owner;
	const proposal = await (await turn(owner))({ cadence: "weekly", weekday: 3, hour: 9 });
	// Someone saves the church's city in Settings > Church, with the same native command the section runs.
	const current = await schedule();
	const plant = { kind: "plant", id: PLANT } as const;
	const context = { session: owner.authority.session, selected: plant } as never;
	const saved = await withSettingsWrite(church.db, owner.authority, context, (tx) =>
		native.settings.updatePlantProfile(tx, context, {
			requestKey: randomUUID(),
			expectedRevision: String(current!.revision),
			input: { plant, patch: { city: "Round Rock" } },
		}),
	);
	assert.equal(saved.status, "ok");
	const changed = await schedule();
	const result = await approve(owner, proposal);
	assert.equal(result.outcome, "refused");
	assert.equal(result.review.receipt?.code, "revision_conflict");
	assert.deepEqual(await schedule(), changed, "the digest stays off");
});
