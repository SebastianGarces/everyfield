import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { sectionOperations } from "../../../../packages/domain/src/settings/index.ts";
import {
	approveProposal,
	createConversation,
	executeProposal,
	prepareProposal,
	readCatalog,
	readReview,
	submitTurn,
} from "../../../../packages/evry/src/index.ts";
import { transaction } from "../../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../../packages/domain/src/jobs/queue.ts";
import { goldenChurch, NETWORK, PLANT, type GoldenChurch } from "../../evals/golden-church.mts";
import { nativePorts } from "../../evals/settings-ports.mts";

const OPERATION = "privacy.setSharing";
const native = nativePorts();
let church: GoldenChurch;
before(async () => {
	church = await goldenChurch({ seatNames: true });
});
after(() => church?.close());

const link = async () =>
	(
		await church.admin.execute(
			sql`SELECT id,revision::text AS revision,consent_revision::text AS consent,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings
				FROM affiliation WHERE plant_id=${PLANT} AND organization_id=${NETWORK} AND ended_at IS NULL`,
		)
	).rows[0] as Record<string, unknown> & { id: string; revision: string; consent: string };
const others = async () =>
	(
		await church.admin.execute(
			sql`SELECT to_jsonb(a) AS row FROM affiliation a WHERE NOT (plant_id=${PLANT} AND organization_id=${NETWORK}) ORDER BY id`,
		)
	).rows;
const outcomes = async (id: string) =>
	(
		await church.admin.execute(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE action='sharing.changed' AND subject_id=${id}`,
		)
	).rows[0]!.n as number;
const reset = () =>
	church.admin.execute(
		sql`UPDATE affiliation SET revision=4,consent_revision=7,share_people=false,share_meetings=true,share_tasks=false,share_ministry_teams=false,
			share_wiki=true,share_activity=true,shared_findings=false WHERE plant_id=${PLANT} AND organization_id=${NETWORK}`,
	);

async function viaEvry(who: "owner" | "admin", category: string, enabled: boolean) {
	const actor = church.actors[who];
	const c = await createConversation(church.db, actor, { requestKey: randomUUID() });
	await submitTurn(church.db, actor, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [turn] = await claimDue(church.db, ["assistant_turn"], 1, 240);
	assert.ok(turn);
	const proposal = await prepareProposal(
		church.db,
		actor,
		{ turnId: turn.id, tenantId: turn.tenant_id, leaseOwner: turn.lease_owner, generation: turn.claim_generation },
		c.id,
		{ operation: OPERATION, input: { organizationId: NETWORK, category, enabled } },
		null,
		native,
	);
	assert.ok(proposal);
	const run = async () => {
		const approved = await approveProposal(
			church.db,
			actor,
			proposal.id,
			{ revision: proposal.revision, digest: proposal.digest },
			null,
		);
		const [claim] = await claimDue(church.db, ["evry_effect"], 1, 60);
		if (!claim) return { replayed: approved.replayed, outcome: null };
		const outcome = await executeProposal(
			church.db,
			{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
			{
				reminders: async () => {
					throw Error("unexpected task reminder replan");
				},
				phaseNotices: async () => undefined,
			},
			null,
			native,
		);
		await transaction(church.db, (tx) =>
			finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }),
		);
		return { replayed: approved.replayed, outcome };
	};
	return { run, review: () => readReview(church.db, actor, proposal.id), proposal };
}

test("AC:TARGET-IDN-010 an Owner's and an Admin's reviewed Evry sharing change ends as the native Settings save does, once, and a stale review changes nothing", async () => {
	const sections = sectionOperations({
		organizations: native.organizations,
		organizationEffects: {
			invitation: async () => {},
			invalidate: (_tx, input) =>
				sql`UPDATE job SET state='superseded',finished_at=clock_timestamp() WHERE subject_record_id=${input.sourceId} AND kind='digest' AND state='ready'`,
		},
		effects: { replan: async () => randomUUID() },
		suppression: async () => "clear",
	} as Parameters<typeof sectionOperations>[0]);
	const viaSettings = async (who: "owner" | "admin", patch: object) => {
		const actor = church.actors[who];
		const start = await link();
		const reply = await gatedTransaction(church.db, (tx) =>
			sections.saveSection(tx, { session: actor.session, selected: actor.owner } as never, {
				requestKey: randomUUID(),
				expectedRevision: start.revision,
				input: {
					section: "affiliations",
					plant: { kind: "plant", id: PLANT },
					organization: { kind: "organization", id: NETWORK, organizationKind: "sending_network" },
					relationshipId: start.id,
					expectedConsentRevision: start.consent,
					patch,
				},
			}),
		);
		assert.equal(reply.status, "ok", JSON.stringify(reply));
	};
	const kept = await others();
	for (const who of ["owner", "admin"] as const)
		for (const [category, enabled, patch] of [
			["ministry_teams", true, { teams: true }],
			["activity", false, { activityPush: false }],
			["shared_findings", true, { shared_findings: true }],
		] as const) {
			await reset();
			const { id } = await link();
			const recorded = await outcomes(id);
			await viaSettings(who, patch);
			const nativeEnd = await link();
			assert.deepEqual([nativeEnd.consent, nativeEnd.revision], ["8", "5"], category);
			assert.equal(await outcomes(id), recorded + 1);

			await reset();
			const start = await link();
			const reviewed = await viaEvry(who, category, enabled);
			assert.deepEqual(reviewed.proposal.review.changes, [{ field: category, before: !enabled, after: enabled }]);
			assert.deepEqual(await link(), start, "nothing changes until approval");
			assert.equal(await outcomes(id), recorded + 1);
			assert.deepEqual(await reviewed.run(), { replayed: false, outcome: "completed" });
			assert.deepEqual(await link(), nativeEnd, `${who} ${category}`);
			assert.equal(await outcomes(id), recorded + 2);
			assert.deepEqual(await reviewed.run(), { replayed: true, outcome: null });
			assert.deepEqual(await link(), nativeEnd);
			assert.equal(await outcomes(id), recorded + 2);
		}
	await reset();
	const { id } = await link();
	const recorded = await outcomes(id);
	const stale = await viaEvry("admin", "wiki", false);
	await viaSettings("owner", { tasks: true });
	const changed = await link();
	await stale.run();
	assert.deepEqual(await link(), changed);
	assert.equal(await outcomes(id), recorded + 1);
	assert.notEqual((await stale.review()).outcome, "completed");
	for (const who of ["member", "network", "org"] as const)
		assert.equal(
			readCatalog(church.actors[who]).reviewedWrites.some((w) => w.operation === OPERATION),
			false,
			who,
		);
	assert.deepEqual(await others(), kept);
});
