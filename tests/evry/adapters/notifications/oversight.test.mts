import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	createConversation,
	executeProposal,
	invokeRead,
	prepareProposal,
	readConversation,
	readReview,
	submitTurn,
	type EvryActor,
	type Proposal,
} from "../../../../packages/evry/src/index.ts";
import { oversightDigest } from "../../../../packages/evry/src/adapters/notifications/reads/index.ts";
import { NOTIFICATION_COMMANDS } from "../../../../packages/evry/src/adapters/notifications/commands/index.ts";
import {
	compileOversightDigest,
	getPreferences,
	renderOversightDigest,
} from "../../../../packages/domain/src/notifications/index.ts";
import { transaction } from "../../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../../apps/web/src/server/jobs/queue.ts";
import {
	accounts,
	actor,
	admin,
	db,
	organization,
	otherPlant,
	plant,
	setup,
	sql,
	teardown,
	work,
} from "../../runtime/support.mts";

// WP-081 and WP-082 for an organization (T-341, D-1278): an organization Owner previews their own next oversight
// digest and changes its cadence only through a review they approve. The database is real, every effect runs through
// the real queue and every turn uses the scripted model.

const ZONE = "America/Chicago";
const DAY = 86_400_000;
const CARE = "Confidential: Robin asked us to pray about a hard diagnosis.";
const civil = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE }).format(new Date(at));
/** Noon in Chicago `days` before today: far from any day boundary. */
const noon = (days: number) => `${civil(Date.now() - days * DAY)}T18:00:00Z`;
const endedPlant = randomUUID();
let owner: EvryActor;

async function activity(tenant: string, at: string, n: number, after: object = {}) {
	for (let k = 0; k < n; k++)
		await admin.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,occurred_at,recorded_at,after_value)
			VALUES(${tenant},${accounts.owner.id},'people.updated','edit','command',${tenant},${at},${at},${JSON.stringify(after)}::jsonb)`);
}
async function affiliate(tenant: string, share: boolean, ended = false) {
	await admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,ended_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${tenant},${organization},clock_timestamp()-interval '30 days',${ended ? sql`clock_timestamp()-interval '10 days'` : null},false,false,false,false,false,${share},false)`);
}
const preview = () => invokeRead(db, owner, oversightDigest, {});
/** What the Owner reads back: the rows any preview changes. */
const effects = async () =>
	(
		await admin.execute(sql`SELECT
			(SELECT coalesce(json_agg(c ORDER BY c.id),'[]') FROM digest_coverage c) AS coverage,
			(SELECT count(*)::int FROM job WHERE kind<>'assistant_turn') AS jobs,
			(SELECT count(*)::int FROM notice) AS notices,
			(SELECT count(*)::int FROM audit_event) AS audits`)
	).rows[0];

async function ask(text: string) {
	const c = await createConversation(db, owner, { requestKey: randomUUID() });
	await submitTurn(db, owner, c.id, { requestKey: randomUUID(), text });
	assert.equal(await work(), "succeeded");
	const page = await readConversation(db, owner, c.id);
	const proposals = await admin.execute(sql`SELECT count(*)::int n FROM proposal WHERE conversation_id=${c.id}`);
	return {
		text: page.events
			.filter((e) => e.kind === "assistant_text")
			.map((e) => (e.body as { text: string }).text)
			.join(""),
		proposals: Number(proposals.rows[0]!.n),
	};
}

before(async () => {
	await setup();
	owner = await actor("orgOwner");
	await admin.execute(sql`UPDATE plant SET name='Hope Fellowship' WHERE id=${plant}`);
	await admin.execute(sql`UPDATE plant SET name='Quiet Creek' WHERE id=${otherPlant}`);
	await admin.execute(sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision)
		VALUES(${endedPlant},'Ended Ridge',${ZONE},7,14,1,8,1,1)`);
	await affiliate(plant, true);
	await affiliate(otherPlant, false);
	await affiliate(endedPlant, true, true);
	// The Owner's oversight digest last covered three days ago, so the next one covers the two days since and today.
	await admin.execute(sql`INSERT INTO digest_coverage(tenant_id,recipient_id,purpose,cadence,timezone,covered_through)
		VALUES(${organization},${accounts.orgOwner.id},'oversight','daily',${ZONE},${civil(Date.now() - 3 * DAY)})`);
	// Hope Fellowship's activity, one change of it naming a person; activity of the plants that share none.
	await activity(plant, noon(2), 3);
	await activity(plant, noon(1), 1, { display_name: "Robin Care", note: CARE });
	await activity(otherPlant, noon(1), 4);
	await activity(endedPlant, noon(1), 2);
	// Private care in Hope Fellowship.
	const person = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${person},${plant},${plant},'Robin Care','other',clock_timestamp(),'prospect','unknown','unknown',5,'live')`);
	await admin.execute(sql`INSERT INTO person_note(tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${plant},${plant},${person},${accounts.owner.id},${CARE},clock_timestamp(),clock_timestamp())`);
});
after(teardown);

test("INV-oversight-preview the next oversight digest is what the runner compiles and renders for its send time, with plant names, dates and counts only", async () => {
	const before = await effects();
	const result = await preview();
	const [head, ...lines] = result.rows;
	assert.equal(head!.id, "next");
	// Daily at 07:00 in Chicago: the next one goes out at the next 07:00 and covers completed days since the coverage.
	assert.match(String(head!.fields.sendsAt), /, 7:00 AM$/);
	assert.equal(head!.fields.from, civil(Date.now() - 2 * DAY));
	assert.equal(head!.fields.cadence, "daily");
	assert.equal(head!.fields.sent, true);
	const to = String(head!.fields.to);
	const digest = await compileOversightDigest(admin, {
		organization,
		recipient: accounts.orgOwner.id,
		start: String(head!.fields.from),
		end: to,
		zone: ZONE as never,
	});
	const text = renderOversightDigest({ start: String(head!.fields.from), end: to, ...digest });
	assert.equal(head!.label, text.title);
	assert.deepEqual(
		lines.map((l) => l.label),
		text.lines,
	);
	// Hope Fellowship's two days only: Quiet Creek shares no activity and Ended Ridge's affiliation ended.
	const day = (days: number) =>
		new Date(Date.now() - days * DAY).toLocaleDateString("en-US", {
			timeZone: ZONE,
			month: "short",
			day: "numeric",
			year: "numeric",
		});
	assert.deepEqual(
		lines.map((l) => l.label),
		[`Hope Fellowship: 3 activities on ${day(2)}.`, `Hope Fellowship: 1 activity on ${day(1)}.`],
	);
	assert.equal(result.total, 4);
	assert.doesNotMatch(JSON.stringify(result), /Robin|diagnosis|pray|Quiet Creek|Ended Ridge/);
	// Reading changes nothing: no coverage moves, no digest is queued or sent and no notice is created.
	assert.deepEqual(await effects(), before);
	const answer = await ask("What will my next oversight digest say?");
	assert.match(answer.text, /Hope Fellowship: 3 activities/);
	assert.doesNotMatch(answer.text, /Robin|diagnosis|Quiet Creek|Ended Ridge/);
	const { audits: _turnAudits, ...after } = (await effects()) as Record<string, unknown>;
	const { audits: _beforeAudits, ...was } = before as Record<string, unknown>;
	assert.deepEqual(after, was);
});

test("INV-oversight-preview with no shared activity in the period, Evry says the digest would not be sent", async () => {
	await admin.execute(sql`UPDATE affiliation SET share_activity=false WHERE plant_id=${plant}`);
	try {
		const [head, ...lines] = (await preview()).rows;
		assert.equal(head!.fields.sent, false);
		assert.deepEqual(lines, []);
		const answer = await ask("What will my next oversight digest say?");
		assert.match(answer.text, /would not be sent/);
	} finally {
		await admin.execute(sql`UPDATE affiliation SET share_activity=true WHERE plant_id=${plant}`);
	}
});

async function propose(operation: string, input: unknown) {
	const c = await createConversation(db, owner, { requestKey: randomUUID() });
	await submitTurn(db, owner, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const run = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	return prepareProposal(db, owner, run, c.id, { operation, input });
}
async function runNext() {
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	if (!claim) return null;
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		async () => {
			throw Error("unexpected task reminder replan");
		},
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return outcome;
}
const approve = (proposal: Proposal) =>
	approveProposal(db, owner, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
const settingsCadence = async () => {
	const reply = await getPreferences(db, owner.authority);
	assert.equal(reply.status, "ok");
	return reply.status === "ok" ? reply.value.oversightCadence : null;
};
const audits = async () => Number((await admin.execute(sql`SELECT count(*)::int n FROM audit_event`)).rows[0]!.n);

test("INV-digest-cadence daily to weekly is reviewed, changes nothing until approved, saves as Settings shows it and a second approval writes nothing", async () => {
	const proposal = await propose("notifications.oversightDigestCadence.set", { cadence: "weekly" });
	assert.ok(proposal);
	assert.deepEqual(proposal.review.changes, [
		{
			field: "oversight_digest.cadence",
			before: { cadence: "daily", weekday: 1, hour: 7 },
			after: { cadence: "weekly", weekday: 1, hour: 7 },
		},
	]);
	assert.equal(proposal.review.refusal, undefined);
	assert.equal(await settingsCadence(), "daily", "nothing changes before approval");
	const first = await approve(proposal);
	assert.equal(first.replayed, false);
	assert.equal(await runNext(), "completed");
	assert.equal((await readReview(db, owner, proposal.id)).outcome, "completed");
	assert.equal(await settingsCadence(), "weekly");
	// Approving the same card again returns it as already applied and writes nothing.
	const writes = await audits();
	const again = await approve(proposal);
	assert.equal(again.replayed, true);
	assert.equal(again.proposal.outcome, "completed");
	assert.equal(await runNext(), null);
	assert.equal(await audits(), writes);
	// The weekly digest goes out on Mondays at 07:00 and covers the seven days to the Sunday before.
	const [head] = (await preview()).rows;
	assert.match(String(head!.fields.sendsAt), /^Mon, .*, 7:00 AM$/);
	assert.equal(head!.fields.cadence, "weekly");
	// Asking again for what is already set is a review that can't be approved.
	assert.ok((await propose("notifications.oversightDigestCadence.set", { cadence: "weekly" }))?.review.refusal);
});

test("INV-digest-cadence only daily or weekly, only the account's own: the input names no account, organization, zone or schedule, and Evry proposes nothing else", async () => {
	for (const cadence of ["every_3_hours", "hourly", "fridays_at_noon"])
		await assert.rejects(propose("notifications.oversightDigestCadence.set", { cadence }), /invalid_input/);
	await assert.rejects(
		propose("notifications.oversightDigestCadence.set", { cadence: "daily", accountId: accounts.owner.id }),
		/invalid_input/,
	);
	const write = NOTIFICATION_COMMANDS["notifications.oversightDigestCadence.set"];
	const shapes = [write.input.toJSONSchema(), oversightDigest.input.toJSONSchema()];
	assert.deepEqual(shapes[0], {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		type: "object",
		properties: {
			cadence: { type: "string", enum: ["daily", "weekly"], description: "daily or weekly; there is no other choice" },
		},
		required: ["cadence"],
		additionalProperties: false,
	});
	assert.doesNotMatch(
		JSON.stringify(shapes[1]),
		/account|recipient|person|user|organization|zone|hour|weekday|schedule/i,
	);
	for (const [text, says] of [
		["Send my oversight digest every 3 hours", /daily or weekly/],
		["Send my oversight digest on Fridays at noon", /daily or weekly/],
		["Change Nora's oversight digest to weekly", /Each person sets their own/],
	] as const) {
		const answer = await ask(text);
		assert.equal(answer.proposals, 0, text);
		assert.match(answer.text, says, text);
	}
	// A request Settings offers gets its review.
	assert.equal((await ask("Send my oversight digest daily")).proposals, 1);
});
