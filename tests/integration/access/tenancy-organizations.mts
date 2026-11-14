// The organizations reads of INV-tenancy (tenancy.test.mts): church A's live connection with a sending network, made
// through the organizations adapter's invite and accept as each side's owner, so the connection has history.
import assert from "node:assert/strict";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { queueJobs } from "../../../apps/web/src/server/jobs/queue.ts";
import {
	createOrganizationAdapter,
	readHistory,
	readPlantSharing,
	readReportingLocation,
	suggestRegions,
} from "../../../packages/domain/src/organizations/index.ts";
import {
	getPlant,
	getSendingChurch,
	listPlants,
	listSendingChurches,
	readIntelligence,
} from "../../../packages/domain/src/oversight/index.ts";

const proofs = new Map();
// The adapter's effects as organizations/support.mts has them, except that the invitation proof is kept here instead
// of mailed, so nothing is sent.
const api = createOrganizationAdapter(
	{
		async invitation(_tx, v) {
			proofs.set(v.invitationId, v.proof);
		},
		notice: (tx, v) =>
			queueJobs(tx, [
				{
					tenant: v.pair.kind === "plant" ? v.pair.subject.id : v.pair.organization.id,
					kind: "notification",
					subject: v.relationshipId,
					key: `${v.kind}/${v.eventId}`,
					revision: v.revision,
					eligibleAt: new Date().toISOString(),
				},
			]),
		invalidate: (_tx, v) =>
			sql`UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,
				revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=${v.sourceId}
				AND kind IN ('assessment','digest') AND state IN ('ready','retry_wait','claimed')`,
	},
	{ candidates: async () => [] },
);

/** Church A's owner invites the MARK network, whose owner accepts: one live connection with an approval in history. */
export async function seedOrganizations(t) {
	const { a, f, MARK, key } = t;
	// Raw rows because no public write creates an organization; its owner seat comes from the fixture for the same reason.
	a.network = key();
	await f.admin.execute(sql`INSERT INTO organization(id,kind,name,timezone,material_revision)
		VALUES(${a.network},'sending_network',${`${MARK} network`},'UTC',1)`);
	const network = { kind: "organization", id: a.network, organizationKind: "sending_network" };
	const networkOwner = await f.account();
	await f.seat(networkOwner, network, "owner");
	// As the production command mount runs a write: the write gate first, then the adapter, in one transaction.
	const write = (session, selected, name, expectedRevision, input) =>
		f.db.transaction(async (tx) => {
			if (!(await RequestActor.claimWrite(tx, session, selected))) throw Error("unavailable");
			return api[name](tx, session, selected, { requestKey: key(), expectedRevision, input });
		});
	// The invitation carries the plant's revision, which the earlier seeds moved on.
	const [plant] = await t.rows(sql`SELECT revision::text FROM plant WHERE id = ${t.plantA.id}`);
	const invitation = await write(t.ownerA.session, t.plantA, "associations.invite", plant.revision, {
		pair: { kind: "plant", subject: t.plantA, organization: network },
		recipientEmail: networkOwner.email,
	});
	const accepted = await write(networkOwner.session, network, "associations.acceptInvitation", "1", {
		invitationId: invitation.invitationId,
		proof: proofs.get(invitation.invitationId),
		decision: "accept",
	});
	assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
	a.pair = invitation.pair;
}

export function organizationsCases(t, who) {
	const { a, MARK } = t;
	const plain = async (body) => ({ status: "ok", value: await body() });
	return [
		[
			"organizations:readHistory",
			{
				run: () => plain(() => readHistory(t.f.db, who.actor, { plant: t.plantA, pair: a.pair })),
				expected: {
					value: { status: "unavailable" },
					control: (value) => {
						assert.equal(value.status, "available");
						assert.deepEqual(
							value.activeRelationships.map((r) => r.pair.organization.id),
							[a.network],
						);
						assert.ok(value.items.some((item) => item.event === "approved"));
					},
				},
			},
		],
		[
			"organizations:readPlantSharing",
			{
				run: () => plain(() => readPlantSharing(t.f.db, who.actor, a.network)),
				expected: {
					value: {},
					control: (value) => {
						const entries = Object.values(value);
						assert.equal(entries.length, 1);
						assert.equal(entries[0].sharing.organizationDisplayName, `${MARK} network`);
					},
				},
			},
		],
		// Oversight reads are for organization seats only: a church's owner, naming church A and its network, gets none.
		// Church A's own owner holds a plant seat too, so there is no control to read.
		...(
			[
				["oversight:listPlants", () => listPlants(t.f.db, who.actor)],
				["oversight:getPlant", () => getPlant(t.f.db, who.actor, t.plantA.id)],
				["oversight:listSendingChurches", () => listSendingChurches(t.f.db, who.actor)],
				["oversight:getSendingChurch", () => getSendingChurch(t.f.db, who.actor, a.network)],
				["oversight:readIntelligence", () => readIntelligence(t.f.db, who.actor, { level: "portfolio", runId: null })],
			] as const
		).map(([name, read]) => [name, { run: () => plain(read), expected: { value: null, control: null } }]),
		// The church settings' reporting location reads only the caller's own plant: church B gets its own, never A's.
		[
			"organizations:readReportingLocation",
			{
				run: () => plain(() => readReportingLocation(t.f.db, who.actor)),
				expected: {
					check: (value) => assert.equal(value.region, null),
					control: (value) => assert.equal(value.canEdit, true),
				},
			},
		],
		// Suggestions read only the global official list; naming church A's city returns no church A value.
		[
			"organizations:suggestRegions",
			{
				run: () => plain(() => suggestRegions(t.f.db, who.actor, { city: MARK, stateProvince: null, country: null })),
				expected: { value: [], control: null },
			},
		],
	];
}
